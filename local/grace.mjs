#!/usr/bin/env node
/**
 * Grace, on your own machine.
 *
 * One command that gets her from a fresh copy of this repository to a working
 * assistant: it checks what is missing, asks only for what it cannot work out,
 * builds what needs building, and starts both halves of her.
 *
 * What changes when she runs here rather than on Vercel, and it is worth being
 * clear about all three:
 *
 *   - Her hands are direct. Listing a folder, reading a file, running a
 *     command: no queue, no polling, no token. She *is* the program on the
 *     machine, so there is nothing to ask.
 *   - Her voice needs no Google VM. The reason the outpost existed is that
 *     Vercel cannot hold a socket open for the length of a conversation.
 *     This can, so the same program runs here, on this machine, and the
 *     browser opens its socket to localhost.
 *   - Her memory never leaves. It was always encrypted on disk; now the disk
 *     is yours.
 *
 * What you lose, equally plainly: she is reachable from this machine only. No
 * phone, no other room, and nothing at all while the computer is asleep.
 *
 *   node local/grace.mjs
 */

import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, statSync, readdirSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readEnv, writeEnv} from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env.local');

const say = (text) => console.log(text);
const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const fail = (text) => {
  console.error(`\n${text}\n`);
  process.exit(1);
};

// ---- what she needs to exist at all ---------------------------------------

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  fail(
    `This needs Node 20 or newer, and this is Node ${process.versions.node}.\n` +
      `Get a current one from https://nodejs.org and run this again.`,
  );
}

const env = readEnv(envFile);

/*
 * Anything already in the environment counts as an answer.
 *
 * So this can be driven from a login item, a service file or a one-off
 * `GRACE_PASSWORD=... npm run local` without a terminal in sight. The saved
 * file wins where both exist, because that is the one somebody chose on
 * purpose and wrote down.
 */
for (const key of [
  'GRACE_PASSWORD',
  'GRACE_SECRET',
  'GCP_PROJECT_ID',
  'GCP_LOCATION',
  'GCP_SERVICE_ACCOUNT_JSON',
  'GRACE_DATA_DIR',
  'PORT',
  'GRACE_VOICE_PORT',
]) {
  if (process.env[key]) env[key] ??= process.env[key];
}

/**
 * Asking, when there is somebody there to ask.
 *
 * Run from a desktop shortcut, a login item or a pipe, there is no terminal on
 * the other end — and a question asked into one of those does not fail, it
 * simply never comes back. A launcher that hangs forever with no output is the
 * worst of the available behaviours, so anything without an answer to fall
 * back on says what to set and stops.
 */
const interactive = Boolean(process.stdin.isTTY);

/**
 * Made only when something is actually going to be asked.
 *
 * A readline interface takes stdin the moment it exists, and the hidden reader
 * below needs stdin to itself. Since a second run answers everything from
 * .env.local and asks nothing at all, the common case builds neither.
 */
let ask = null;
function reader() {
  if (!ask) ask = createInterface({input: process.stdin, output: process.stdout});
  return ask;
}

/**
 * A password, read without putting it on the screen.
 *
 * The first version of this let readline echo, and a freshly chosen password
 * went into the terminal's scrollback — from where it can be read over a
 * shoulder, scrolled back to, or pasted into a bug report along with
 * everything else on screen. That is exactly how this one leaked.
 *
 * Written out by hand rather than through readline because readline's echo is
 * not a per-keystroke thing that can be muted: it redraws the whole line, so
 * an override that prints a dot per call prints one dot and then the entire
 * password on the next redraw. Raw mode, one character at a time, is both
 * simpler and the only version that is actually true.
 */
function askHidden(question) {
  return new Promise((done) => {
    const input = process.stdin;
    process.stdout.write(question);

    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';
    const finish = (result) => {
      input.removeListener('data', onKey);
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
      process.stdout.write('\n');
      done(result);
    };

    const onKey = (chunk) => {
      for (const key of chunk) {
        // Enter, and end-of-input: both mean "that is the whole thing".
        if (key === '\r' || key === '\n' || key === '\u0004') return finish(value);
        // Ctrl+C has to keep working, and raw mode is where it stops doing so
        // by itself — without this the only way out is closing the window.
        if (key === '\u0003') {
          finish('');
          process.exit(130);
        }
        if (key === '' || key === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        // Arrow keys and the like arrive as escape sequences; a password is
        // not a place to be clever about cursor movement, so they are ignored.
        if (key < ' ') continue;
        value += key;
        process.stdout.write('*');
      }
    };

    input.on('data', onKey);
  });
}

async function askFor(question, {fallback, orSet, secret = false}) {
  if (interactive) {
    const answer = secret ? await askHidden(question) : await reader().question(question);
    return answer.trim() || fallback || '';
  }
  if (fallback) return fallback;
  fail(
    `I need to ask you something and there is no terminal to ask in.\n\n` +
      `Either run this from a terminal, or put ${orSet} in .env.local yourself.`,
  );
}

step('Checking what she needs');

/*
 * A password, because she is reachable from anything on this machine.
 *
 * "It is only localhost" is not quite the argument it sounds like: every
 * program you run, and every page you open, can reach localhost. Hers holds
 * mail, a diary, and a shell.
 */
if (!env.GRACE_PASSWORD) {
  const chosen = await askFor('  Pick a password for Grace: ', {
    orSet: 'GRACE_PASSWORD',
    secret: true,
  });
  if (chosen.length < 6) fail('That is too short to be worth having. Try again.');
  env.GRACE_PASSWORD = chosen;
}

/*
 * The key that encrypts her memory at rest.
 *
 * Made here rather than asked for, because there is no reason for a person to
 * choose it and every reason for it to be random. Written once and then left
 * alone — changing it makes everything she already remembers unreadable.
 */
if (!env.GRACE_SECRET) {
  env.GRACE_SECRET = randomBytes(32).toString('base64url');
  say('  Made a key to encrypt her memory.');
}

if (!env.GCP_PROJECT_ID) {
  env.GCP_PROJECT_ID = await askFor('  Google Cloud project id [ai-agents-508818]: ', {
    fallback: 'ai-agents-508818',
  });
}
env.GCP_LOCATION ??= 'global';

/*
 * The service-account key, which this never asks you to type or paste.
 *
 * It is a multi-line JSON document and belongs in a file, not in an answer to
 * a prompt — and nothing here should ever be in a position to have read it.
 * So: put the file next to this one, and the only thing that happens to it is
 * being handed to Google's own library.
 */
const keyFile = join(root, 'local', 'service-account.json');

/**
 * Where a freshly downloaded key actually is.
 *
 * Google names it after the project and a browser puts it in Downloads, so the
 * step between downloading it and this script finding it is pure clerical work
 * — and the kind people get wrong, because Windows hides the extension and
 * saving from Notepad quietly appends `.txt`. Looking in the obvious place
 * removes the step rather than explaining it.
 *
 * Only files that are a service-account key for this project are offered, and
 * the check is the file's own contents rather than its name.
 */
function inDownloads(project) {
  const downloads = join(homedir(), 'Downloads');
  if (!existsSync(downloads)) return null;

  try {
    for (const name of readdirSync(downloads)) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const path = join(downloads, name);
      try {
        if (statSync(path).size > 16_000) continue;
        const body = JSON.parse(readFileSync(path, 'utf8'));
        if (body.type === 'service_account' && body.project_id === project) {
          return {path, email: body.client_email};
        }
      } catch {
        // Not JSON, not readable, not ours. Any of those means "not this one".
      }
    }
  } catch {
    // No Downloads folder worth reading. Fall through to asking.
  }
  return null;
}

if (!env.GCP_SERVICE_ACCOUNT_JSON) {
  let found = existsSync(keyFile) ? keyFile : null;

  if (!found) {
    const downloaded = inDownloads(env.GCP_PROJECT_ID);
    if (downloaded) {
      say(`  Found a key for this project in Downloads: ${downloaded.path}`);
      say(`    it belongs to ${downloaded.email}`);
      const yes = await askFor('    Use it? [Y/n] ', {fallback: 'y'});
      if (!/^n/i.test(yes)) {
        writeFileSync(keyFile, readFileSync(downloaded.path), {mode: 0o600});
        found = keyFile;
        say(`  Copied it to ${keyFile}. You can delete the one in Downloads.`);
      }
    }
  }

  if (!found) {
    ask?.close();
    fail(
      `She needs the Google service-account key to think.\n\n` +
        `Save the JSON file you downloaded from Google Cloud as:\n\n` +
        `  ${keyFile}\n\n` +
        `If you have not got one on this machine, make a new one — a service\n` +
        `account can hold several, so this does not disturb the one on Vercel:\n\n` +
        `  https://console.cloud.google.com/iam-admin/serviceaccounts?project=${env.GCP_PROJECT_ID}\n` +
        `  the account → Keys → Add key → Create new key → JSON\n\n` +
        `Then run this again. Nothing reads it except Google's own library, and\n` +
        `it never leaves this machine.`,
    );
  }

  env.GCP_SERVICE_ACCOUNT_JSON = readFileSync(found, 'utf8').trim();
  say('  Found the Google key.');
}

/*
 * The key is checked here, rather than discovered to be broken by Google.
 *
 * It arrived as a file and it is about to be handed to a library that will
 * fail somewhere far from here if it is not what it claims to be — which is
 * exactly what happened when this was being mangled on its way through the
 * settings file: an error inside the SDK, three layers down, saying nothing
 * about where the value came from.
 */
try {
  const parsed = JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON);
  if (!parsed.client_email || !parsed.private_key) {
    ask?.close();
    fail(
      `${keyFile} is JSON, but not a service-account key — it has no ` +
        `client_email or private_key. Download a fresh one from Google Cloud.`,
    );
  }
} catch {
  ask?.close();
  fail(
    `${keyFile} is not valid JSON, so Google will refuse it.\n\n` +
      `Download the key again and save it whole, including the outermost ` +
      `braces. Do not paste it into a settings file — this reads the file ` +
      `itself, every time she starts.`,
  );
}

env.GRACE_DATA_DIR ??= join(root, '.grace');
env.PORT ??= '7766';
// The voice needs a second port, because it is a socket rather than a request.
env.GRACE_VOICE_PORT ??= '8787';
env.GRACE_OUTPOST_URL ??= `ws://localhost:${env.GRACE_VOICE_PORT}/voice`;

writeEnv(envFile, env);
ask?.close();
say(`  Settings saved to .env.local — that file holds your secrets, so keep it.`);

// ---- building what needs building ------------------------------------------

function run(command, args, extra = {}) {
  const done = spawnSync(command, args, {cwd: root, stdio: 'inherit', shell: true, ...extra});
  if (done.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed.`);
}

/*
 * Installed when missing, and again when a pull has changed what she needs.
 *
 * npm stamps node_modules/.package-lock.json on every install, so a lockfile
 * newer than that stamp means `git pull` brought a dependency this machine
 * does not have yet — and without this she would start, reach for it, and
 * crash with a module-not-found that says nothing about pulling.
 */
const lockAt = (path) => (existsSync(path) ? statSync(path).mtimeMs : 0);
const installedAt = lockAt(join(root, 'node_modules', '.package-lock.json'));
if (!existsSync(join(root, 'node_modules'))) {
  step('Installing what she is built from (this takes a minute)');
  run('npm', ['install']);
} else if (lockAt(join(root, 'package-lock.json')) > installedAt && installedAt > 0) {
  step('Something she depends on changed — updating');
  run('npm', ['install']);
}

// `ws` is the outpost's, not the app's, and the outpost has its own manifest.
if (!existsSync(join(root, 'node_modules', 'ws'))) {
  step('Installing the piece that holds her voice open');
  run('npm', ['install', 'ws', '--no-save']);
}

/**
 * Rebuild when the source is newer than the build, and not otherwise.
 *
 * Starting her should be quick enough that you do it without thinking about
 * it, and an unconditional build makes that a fifteen-second decision every
 * time. Comparing timestamps is not perfect — it will miss a change in a file
 * this does not look at — and `npm run build` is always there for the rest.
 */
function newestUnder(directory) {
  let newest = 0;
  const walk = (at) => {
    for (const entry of readdirSync(at, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  walk(directory);
  return newest;
}

const built = join(root, 'dist', 'index.html');
const builtAt = existsSync(built) ? statSync(built).mtimeMs : 0;
// public/ too: her audio worklets live there, and a pull that changed only
// one of them would otherwise keep serving the old copy from dist/.
const sourceAt = Math.max(
  newestUnder(join(root, 'src')),
  newestUnder(join(root, 'shared')),
  newestUnder(join(root, 'public')),
  lockAt(join(root, 'index.html')),
);

if (sourceAt > builtAt) {
  step('Building her interface');
  run('npm', ['run', 'build']);
}

// ---- starting both halves ---------------------------------------------------

const shared = {...process.env, ...env};
const children = [];

/*
 * Her voice, held open on this machine.
 *
 * The same program that runs on the Google VM, because there was never
 * anything about it that needed a Google VM — it needed somewhere that could
 * keep a socket open for the length of a conversation, which Vercel cannot and
 * this obviously can. Started first, so it is listening by the time the
 * browser has finished loading the page.
 */
step('Starting her voice');
children.push(
  spawn('node', [join(root, 'outpost', 'outpost.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...shared,
      PORT: env.GRACE_VOICE_PORT,
      GRACE_URL: `http://localhost:${env.PORT}`,
    },
  }),
);

step('Starting Grace');
children.push(
  spawn('npx', ['tsx', join(root, 'server', 'index.ts')], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: {...shared, GRACE_BRIDGE_EMBEDDED: '1'},
  }),
);

say(`\n  She is at \x1b[1mhttp://localhost:${env.PORT}\x1b[0m — open that in a browser.`);
say(`  Her files, her memory and her voice are all on this machine.`);
say(`  Stop her with Ctrl+C.\n`);

/** One Ctrl+C should stop both halves, not leave a socket server orphaned. */
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// If either half dies, the other is not much use on its own, and a half-dead
// Grace that still serves a page is worse than one that is plainly not there.
for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0) console.error(`\n[grace] one half exited (${code}); stopping the other.`);
    stop();
  });
}
