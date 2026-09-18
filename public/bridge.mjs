#!/usr/bin/env node
/**
 * Grace's hands on your home network.
 *
 * Grace lives in a data centre. A PlayStation answers to nothing but the local
 * network — waking one is a UDP broadcast, and no amount of cloud will put her
 * on your Wi-Fi. So this runs on the laptop that is already switched on in the
 * room, and is her hands there: it wakes and sleeps the console, opens a page
 * on the screen in front of you, and locks the machine when you leave.
 *
 * It only ever dials out. Nothing here listens on a port, so there is no
 * router to reconfigure and nothing on your network is reachable from outside.
 * Every few seconds it asks Grace whether she left an instruction, carries it
 * out, and tells her what happened.
 *
 * Run it with:  npm start
 */

import {spawn} from 'node:child_process';
import dgram from 'node:dgram';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, readdir, readFile, realpath, stat, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve, sep} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function settings() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
  } catch {
    // A config file is the tidy way, not the only way. Two arguments on the
    // command line work just as well, and mean this can be one downloaded
    // file on a machine where you are not allowed to install anything.
  }

  const [, , argUrl, argToken] = process.argv;

  const grace = argUrl ?? process.env.GRACE_URL ?? file.grace ?? '';
  const token = argToken ?? process.env.GRACE_BRIDGE_TOKEN ?? file.token ?? '';

  /*
   * Imported rather than run.
   *
   * When Grace is running on this same machine there is no queue to poll and
   * no token to prove anything with — she calls the work below directly. The
   * boundary is the part worth keeping in one place: two copies of "is this
   * path allowed" would drift, and the day they drifted would be the day
   * somebody lost a folder. So this file is the only implementation, and it
   * can be loaded without its loop.
   */
  const embedded = process.env.GRACE_BRIDGE_EMBEDDED || process.env.GRACE_BRIDGE_CHECK;

  if (!embedded && (!grace || !token)) {
    console.error(
      '\nI need to know where Grace is and how to prove I am yours.\n\n' +
        '  node bridge.mjs https://your-grace-address YOUR-TOKEN\n\n' +
        'The token is in Grace, in the side panel, under "The laptop bridge".\n',
    );
    process.exit(1);
  }

  return {
    grace: grace.replace(/\/+$/, ''),
    token,
    /**
     * How often to ask for instructions.
     *
     * Every check is a request to Grace and a read of her memory, both of
     * which have monthly allowances on the free tiers she runs on.
     *
     * This was fifteen seconds, which was right when the only question was
     * whether a console was awake. It is the wrong number now: it is also how
     * long the *first* thing she is asked to do sits waiting to be noticed,
     * and fifteen seconds of nothing before a directory listing reads as
     * broken rather than slow. Eight is the compromise — about ten thousand
     * requests a day, which stays inside the free allowances with room, and
     * short enough that the first answer arrives while you are still looking
     * at the screen. Everything after it is immediate, because anything
     * arriving puts the loop into the fast mode below.
     */
    everyMs: Number(process.env.GRACE_BRIDGE_POLL_MS ?? file.pollMs ?? 8_000),
    /**
     * How often to look while a conversation is going on.
     *
     * Fifteen seconds is right for "is the console awake" and hopeless for
     * "what is in this folder" — nobody waits a quarter of a minute per
     * question. So the moment anything arrives the loop speeds up, and it
     * slows back down when nothing has come for a couple of minutes. Fast
     * only while it is being used costs almost nothing over a day.
     */
    busyMs: Number(process.env.GRACE_BRIDGE_BUSY_MS ?? file.busyPollMs ?? 900),
    /** Set this if discovery finds the wrong device, or none. */
    ip: process.env.PS5_IP ?? file.ps5Ip ?? '',
    /** Where playactor lives, if it is not in the usual place beside this file. */
    playactor: process.env.PLAYACTOR_CLI ?? file.playactor ?? '',
    /*
     * Which folders she may touch.
     *
     * Home by default, because "my files" means the user's files and not the
     * operating system. It is a list rather than a switch so that it can be
     * widened deliberately — an external drive, a projects folder elsewhere —
     * and narrowed just as deliberately by someone who wants her nowhere near
     * their home directory.
     */
    roots: (
      process.env.GRACE_ROOTS?.split(',') ??
      file.roots ??
      [homedir()]
    ).map((one) => resolve(String(one).trim().replace(/^~(?=$|\/)/, homedir()))),
    /** Longest a single command may run before it is stopped. */
    commandMs: Number(process.env.GRACE_COMMAND_MS ?? file.commandMs ?? 40_000),
  };
}

const config = settings();

// ---- finding the console ------------------------------------------------

/**
 * PlayStation discovery, spoken directly.
 *
 * A one-line UDP message on the port the console listens on. Doing this here
 * rather than shelling out means the state is fresh every single cycle, costs
 * nothing, and still answers when the wake tooling is unhappy — so Grace can
 * always say truthfully whether the console is on.
 */
const PS5_PORT = 9302;
const PROBE = 'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n';

function discover(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    let answered = null;

    const finish = () => {
      try {
        socket.close();
      } catch {
        // Already closed; nothing to do.
      }
      resolve(
        answered ?? {found: false, status: null, name: null, address: null, at: new Date().toISOString()},
      );
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('message', (message, from) => {
      const text = message.toString('utf8');
      // The first line is an HTTP-shaped status: 200 means awake, 620 standby.
      const status = /^HTTP\/1\.1 (\d+)/.exec(text)?.[1];
      const fields = Object.fromEntries(
        text
          .split('\n')
          .slice(1)
          .map((line) => line.split(':'))
          .filter((pair) => pair.length >= 2)
          .map(([key, ...rest]) => [key.trim(), rest.join(':').trim()]),
      );

      answered = {
        found: true,
        status: status === '200' ? 'AWAKE' : 'STANDBY',
        name: fields['host-name'] ?? null,
        address: from.address,
        running: fields['running-app-name'] ?? null,
        at: new Date().toISOString(),
      };

      clearTimeout(timer);
      finish();
    });

    socket.on('error', () => {
      clearTimeout(timer);
      finish();
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      const target = config.ip || '255.255.255.255';
      socket.send(PROBE, PS5_PORT, target, (error) => {
        if (error) {
          clearTimeout(timer);
          finish();
        }
      });
    });
  });
}

// ---- doing something about it -------------------------------------------

/**
 * Waking and sleeping go through playactor.
 *
 * Both need a credential the console only hands out during a pairing dance
 * involving a PIN typed on the television, and playactor already implements
 * all of it. Everything above this line is protocol we speak ourselves;
 * everything below is a program we are asking politely.
 *
 * Where playactor's own entry point is.
 *
 * Deliberately never `npx`, and never the `playactor` command. Both of those
 * are `.cmd` batch files on Windows, and a managed laptop will very often
 * refuse to run a batch file at all — "this program is blocked by group
 * policy" — while being perfectly happy to run node.exe. Calling the
 * JavaScript with the same node that is already running sidesteps the whole
 * category of problem, and needs no permissions of any kind.
 */
function findPlayactor() {
  const candidates = [
    config.playactor,
    join(here, 'node_modules', 'playactor', 'dist', 'cli', 'index.js'),
    join(here, 'playactor', 'node_modules', 'playactor', 'dist', 'cli', 'index.js'),
  ].filter(Boolean);

  return candidates.find((path) => existsSync(path)) ?? null;
}

function playactor(command) {
  return new Promise((resolve) => {
    const cli = findPlayactor();
    if (!cli) {
      resolve({
        ok: false,
        detail:
          'playactor is not installed next to this file — see the README, ' +
          'the "install" step',
      });
      return;
    }

    const args = [
      cli,
      command,
      '--ps5',
      '--no-open-urls',
      ...(config.ip ? ['--ip', config.ip] : []),
    ];

    // process.execPath is the very node that is running this. No shell, no
    // batch file, nothing for a policy to object to.
    const child = spawn(process.execPath, args, {cwd: here});

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));

    // A console that will not answer must not leave this hanging for ever;
    // Grace is waiting on the other end to be able to say what happened.
    const timer = setTimeout(() => child.kill(), 45_000);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ok: false, detail: `could not run playactor: ${error.message}`});
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const detail = output.trim().split('\n').slice(-2).join(' ').slice(0, 200);
      resolve({ok: code === 0, detail: code === 0 ? '' : detail || `exit ${code}`});
    });
  });
}

/**
 * The laptop's own screen, as somewhere she can put things.
 *
 * Deliberately not `cmd /c start` and not PowerShell: this laptop is managed,
 * and the whole reason playactor is invoked through node.exe above is that the
 * policy blocks batch files outright. explorer.exe is an ordinary executable
 * that hands a URL to whatever the default browser is, and openers on the other
 * two platforms are the same shape.
 *
 * Only http and https, checked by parsing rather than by pattern. `file://`
 * would open local documents and the shell schemes can start programs, neither
 * of which is what "open my bank" means.
 */
function openOnScreen(url) {
  return new Promise((resolve) => {
    let address;
    try {
      address = new URL(url);
    } catch {
      resolve({ok: false, detail: `"${url}" is not an address I can open`});
      return;
    }
    if (address.protocol !== 'http:' && address.protocol !== 'https:') {
      resolve({ok: false, detail: 'only web addresses, nothing else'});
      return;
    }

    const opener =
      process.platform === 'win32'
        ? ['explorer.exe', [address.href]]
        : process.platform === 'darwin'
          ? ['open', [address.href]]
          : ['xdg-open', [address.href]];

    const child = spawn(opener[0], opener[1], {detached: true, stdio: 'ignore'});
    child.on('error', (error) =>
      resolve({ok: false, detail: `could not open it: ${error.message}`}),
    );
    // explorer.exe exits non-zero on success often enough that waiting on the
    // code would report every successful open as a failure. Spawning without
    // an error is the honest signal available here.
    child.unref();
    setTimeout(() => resolve({ok: true, detail: address.hostname}), 400);
  });
}

/** Lock the screen and walk away. Nothing closes, nothing is lost. */
function lockScreen() {
  return new Promise((resolve) => {
    const [command, args] =
      process.platform === 'win32'
        ? ['rundll32.exe', ['user32.dll,LockWorkStation']]
        : process.platform === 'darwin'
          ? ['pmset', ['displaysleepnow']]
          : ['loginctl', ['lock-session']];

    const child = spawn(command, args, {detached: true, stdio: 'ignore'});
    child.on('error', (error) =>
      resolve({ok: false, detail: `could not lock it: ${error.message}`}),
    );
    child.unref();
    setTimeout(() => resolve({ok: true, detail: ''}), 400);
  });
}

/**
 * Ask the console to change state, and then look to see whether it did.
 *
 * playactor exits zero having opened a Remote Play session, sent the request
 * and closed again — whether or not the console acted on it. On a PS5 with
 * more than one account this fails routinely: waking leaves a Remote Play
 * connection that never finished, and the standby that follows is swallowed
 * by it. The console stays on, playactor exits zero, and Grace says she has
 * put it to sleep. The documented workaround is to send it two or three
 * times, which is exactly the thing a program should do rather than a person.
 *
 * So the exit code is treated as an opinion and the discovery packet as the
 * fact. Discovery is a two-line UDP exchange that costs nothing and answers
 * even when the wake tooling is unhappy, which makes it the right authority.
 */
async function settle(want, command) {
  let lastDetail = '';

  /*
   * Twice, not three times, and not for long.
   *
   * The retry was added for a documented bug where a second standby lands
   * after the first is swallowed. That turned out not to be what happens
   * here: playactor sends its request, exits zero, prints nothing at all, and
   * the console is entirely unmoved — in both directions, on a console that
   * sleeps and wakes perfectly from its own controller.
   *
   * playactor's last release was February 2022 and PS5 firmware has moved
   * several times since; there is no maintained alternative, and the most
   * recently published PlayStation integration on npm still depends on that
   * same version. So the likeliest reading is an old client speaking a
   * protocol that has moved on, and no number of attempts fixes that. One
   * retry stays because it is nearly free and costs nothing to be wrong
   * about. Waiting forty-five seconds to reach the same conclusion does not.
   */
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ran = await playactor(command);
    if (!ran.ok) lastDetail = ran.detail;

    // A console takes a moment to act; waking is much slower than sleeping.
    const until = Date.now() + (command === 'wake' ? 18_000 : 8000);
    while (Date.now() < until) {
      const state = await discover();
      if (state.found && state.status === want) {
        return {
          ok: true,
          detail: attempt === 1 ? '' : 'it took two attempts',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return {
    ok: false,
    detail:
      lastDetail ||
      `the console ignored it. The tool that speaks to PlayStations was last ` +
        `updated in 2022 and appears not to work with current PS5 firmware — ` +
        `this is very likely not something the user can fix by changing a setting`,
  };
}

// ---- her hands on this machine -------------------------------------------

/**
 * The boundary, and the reason it lives here rather than only in Grace.
 *
 * Grace decides what to ask for. This decides what is allowed, and the two are
 * deliberately not the same program: everything above this line arrived over
 * the internet and was composed by a language model. A check that runs where
 * the request was written is not a check. This one runs on the machine that
 * owns the files, and it is the last word.
 *
 * Resolved rather than compared as text, and through the nearest ancestor that
 * actually exists, because `~/notes/../../../etc/passwd` is a perfectly ordinary
 * looking string and a symlink is a perfectly ordinary looking folder. Asking
 * the filesystem where a path really goes is the only answer that holds.
 */
async function truly(path) {
  let at = resolve(String(path).replace(/^~(?=$|\/)/, homedir()));
  const missing = [];

  for (;;) {
    try {
      return {real: join(await realpath(at), ...missing), existed: missing.length === 0};
    } catch {
      const up = dirname(at);
      // The root of the filesystem does not exist as far as this can tell,
      // which means the path was never going to resolve to anything.
      if (up === at) return {real: resolve(String(path)), existed: false};
      missing.unshift(at.slice(up.length + 1));
      at = up;
    }
  }
}

async function allowed(path) {
  const {real, existed} = await truly(path);

  for (const root of config.roots) {
    let base = root;
    try {
      base = await realpath(root);
    } catch {
      // A root that is not there cannot contain anything.
      continue;
    }
    if (real === base || real.startsWith(base + sep)) return {ok: true, real, existed};
  }

  return {
    ok: false,
    real,
    existed,
    why:
      `${real} is outside the folders this bridge is allowed to touch ` +
      `(${config.roots.join(', ')}). Nothing was read or changed. The list is ` +
      `"roots" in the bridge's config.json.`,
  };
}

/** Enough of a file to be useful, and not enough to cost a fortune to read. */
const MOST_CHARS = 60_000;
/** Enough of a folder to see what is in it. */
const MOST_ENTRIES = 300;

function shortened(text, limit = MOST_CHARS) {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n[...${text.length - limit} more characters, not shown]`
  );
}

async function listFolder(path) {
  const seen = await allowed(path);
  if (!seen.ok) return {ok: false, detail: seen.why};

  const entries = await readdir(seen.real, {withFileTypes: true});
  const lines = [];

  for (const entry of entries.slice(0, MOST_ENTRIES)) {
    if (entry.isDirectory()) {
      lines.push(`${entry.name}/`);
      continue;
    }
    let size = '';
    try {
      const info = await stat(join(seen.real, entry.name));
      size = `  ${info.size} bytes`;
    } catch {
      // A broken symlink or a file that vanished between the listing and the
      // stat. Worth naming, not worth failing the whole listing over.
      size = '  ?';
    }
    lines.push(`${entry.name}${size}`);
  }

  const more =
    entries.length > MOST_ENTRIES
      ? `\n[...${entries.length - MOST_ENTRIES} more]`
      : '';

  return {
    ok: true,
    detail: lines.length
      ? `${seen.real}:\n${lines.join('\n')}${more}`
      : `${seen.real} is empty.`,
  };
}

async function readTextFile(path) {
  const seen = await allowed(path);
  if (!seen.ok) return {ok: false, detail: seen.why};

  const info = await stat(seen.real);
  if (info.isDirectory()) {
    return {ok: false, detail: `${seen.real} is a folder, not a file.`};
  }

  const raw = await readFile(seen.real);
  // A NUL byte in the first few kilobytes means this is not text, and handing
  // a model a megabyte of mangled binary helps nobody and costs real money.
  if (raw.subarray(0, 8000).includes(0)) {
    return {
      ok: false,
      detail: `${seen.real} is a binary file (${info.size} bytes), not text.`,
    };
  }

  return {ok: true, detail: `${seen.real}:\n\n${shortened(raw.toString('utf8'))}`};
}

async function writeTextFile(path, text, replace) {
  const seen = await allowed(path);
  if (!seen.ok) return {ok: false, detail: seen.why};

  if (seen.existed && !replace) {
    return {
      ok: false,
      detail:
        `${seen.real} already exists and I was not told to replace it, so it ` +
        `is untouched. Ask the user whether to overwrite it.`,
    };
  }

  await mkdir(dirname(seen.real), {recursive: true});
  await writeFile(seen.real, String(text ?? ''), 'utf8');
  return {
    ok: true,
    detail: `${seen.existed ? 'Replaced' : 'Wrote'} ${seen.real} (${String(text ?? '').length} characters).`,
  };
}

async function removeFile(path) {
  const seen = await allowed(path);
  if (!seen.ok) return {ok: false, detail: seen.why};
  if (!seen.existed) return {ok: false, detail: `${seen.real} is not there.`};

  const info = await stat(seen.real);
  if (info.isDirectory()) {
    return {
      ok: false,
      detail:
        `${seen.real} is a folder. This deletes one file at a time on purpose ` +
        `— a whole tree is not something to lose to a misheard sentence.`,
    };
  }

  await unlink(seen.real);
  return {ok: true, detail: `Deleted ${seen.real}.`};
}

/**
 * The terminal.
 *
 * Run through the user's own shell, so what works when they type it works when
 * she asks for it — aliases and PATH and all. Stopped after a fixed time,
 * because a command that waits for input waits for ever and would otherwise
 * take the bridge down with it, and read back with both streams together in
 * the order they came, which is what they would have seen on screen.
 */
async function runCommand(command, folder) {
  const where = await allowed(folder || config.roots[0]);
  if (!where.ok) return {ok: false, detail: where.why};

  return new Promise((done) => {
    const child = spawn(command, {
      cwd: where.real,
      shell: true,
      env: process.env,
    });

    let output = '';
    let over = false;
    const keep = (chunk) => {
      if (output.length < MOST_CHARS * 2) output += chunk.toString();
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    // Read per call rather than once at startup, so the boundary check can
    // shorten it without needing a second process.
    const limitMs = Number(process.env.GRACE_COMMAND_MS ?? config.commandMs);
    const timer = setTimeout(() => {
      over = true;
      child.kill('SIGKILL');
    }, limitMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      done({ok: false, detail: `could not run it: ${error.message}`});
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const text = shortened(output.trim()) || '(it printed nothing)';
      if (over) {
        return done({
          ok: false,
          detail:
            `Stopped after ${Math.round(limitMs / 1000)} seconds — it ` +
            `was still running. What it had printed by then:\n\n${text}`,
        });
      }
      done({
        ok: code === 0,
        detail: code === 0 ? text : `It exited with code ${code}.\n\n${text}`,
      });
    });
  });
}

async function carryOut(action, arg, command = {}) {
  if (action === 'ls') return listFolder(arg ?? '');
  if (action === 'read') return readTextFile(arg ?? '');
  if (action === 'write') return writeTextFile(arg ?? '', command.body, command.replace);
  if (action === 'remove') return removeFile(arg ?? '');
  if (action === 'shell') return runCommand(arg ?? '', command.body);

  if (action === 'status') {
    const state = await discover();
    return {ok: state.found, detail: state.found ? `${state.status}` : 'no console answered'};
  }

  if (action === 'wake') return settle('AWAKE', 'wake');
  if (action === 'sleep') return settle('STANDBY', 'standby');
  if (action === 'open') return openOnScreen(arg ?? '');
  if (action === 'lock') return lockScreen();

  return {ok: false, detail: `I do not know how to ${action}`};
}

// ---- the loop ------------------------------------------------------------

let lastState = null;
let quietSince = Date.now();
/** When something last arrived, which decides how eagerly to look for more. */
let busySince = 0;
/** When the console was last looked for, so a fast loop is not a broadcast storm. */
let lookedAt = 0;

/** Fast for two minutes after anything happens, then back to sleepy. */
const BUSY_FOR_MS = 2 * 60 * 1000;
/** The console changes state rarely; asking the network every second is rude. */
const REDISCOVER_MS = 30 * 1000;

async function checkIn(results = []) {
  /*
   * The console hunt, unhooked from the poll rate.
   *
   * It is a UDP broadcast to the whole network, and it used to happen on every
   * cycle because every cycle was fifteen seconds apart. Now a conversation
   * drives the loop at about a second, and a broadcast per second for as long
   * as someone is talking is a genuinely antisocial thing to do to a home
   * network. A console's power state is not news often enough to need it.
   */
  const state =
    Date.now() - lookedAt > REDISCOVER_MS || !lastState
      ? ((lookedAt = Date.now()), await discover())
      : lastState;
  lastState = state;

  const response = await fetch(`${config.grace}/api/bridge`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: config.token, state, results}),
  });

  if (response.status === 401) {
    console.error('Grace does not recognise this token. Check config.json.');
    return [];
  }
  if (!response.ok) throw new Error(`Grace answered ${response.status}`);

  const body = await response.json();
  return body.commands ?? [];
}

async function cycle() {
  const commands = await checkIn();
  if (commands.length === 0) {
    // A quiet line is worth saying once an hour, so a bridge that has silently
    // stopped working is distinguishable from one with nothing to do.
    if (Date.now() - quietSince > 60 * 60 * 1000) {
      quietSince = Date.now();
      console.log(
        `[${new Date().toLocaleTimeString()}] still here — console is ` +
          `${lastState?.found ? lastState.status : 'not answering'}`,
      );
    }
    return;
  }

  busySince = Date.now();

  const results = [];
  for (const command of commands) {
    console.log(
      `[${new Date().toLocaleTimeString()}] ${command.action}` +
        (command.arg ? ` ${command.arg}` : ''),
    );
    const outcome = await carryOut(command.action, command.arg, command);
    // Only the first line, and never the file she just read: this is a log on
    // somebody's laptop, not a place to spill the contents of their documents.
    const said = (outcome.detail ?? '').split('\n')[0].slice(0, 160);
    console.log(`  ${outcome.ok ? `done — ${said}` : `failed: ${said}`}`);
    results.push({id: command.id, ok: outcome.ok, detail: outcome.detail});
  }

  // Reported on its own rather than waiting for the next cycle: Grace is
  // holding a conversation open waiting to hear how it went.
  await checkIn(results);
  quietSince = Date.now();
}

/*
 * The boundary is worth testing, so it has to be reachable without the loop.
 *
 * check.mjs imports this file to run the path and command cases against a real
 * filesystem. Without this it would start polling a made-up address instead.
 */
export {carryOut, allowed, runCommand};

if (process.env.GRACE_BRIDGE_CHECK || process.env.GRACE_BRIDGE_EMBEDDED) {
  // Loaded for its hands rather than its loop: by the boundary checks, and by
  // Grace herself when she is running on this machine.
} else {

console.log(`Grace bridge — talking to ${config.grace}`);
const first = await discover();
console.log(
  first.found
    ? `Found ${first.name ?? 'a console'} at ${first.address}, currently ${first.status}.`
    : 'No console answered yet. That is normal if it is unplugged or on another network.',
);

for (;;) {
  try {
    await cycle();
  } catch (error) {
    // Wi-Fi drops, laptops sleep, Grace redeploys. None of that should end the
    // bridge — it should simply try again in a moment.
    console.error(`  trouble: ${error.message}`);
  }
  const eager = Date.now() - busySince < BUSY_FOR_MS;
  await new Promise((wait) => setTimeout(wait, eager ? config.busyMs : config.everyMs));
}

}
