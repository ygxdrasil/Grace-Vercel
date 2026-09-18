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
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

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

/**
 * Reading and writing .env.local, which is the one place her secrets live.
 *
 * Deliberately never printed, never echoed back, and never sent anywhere. The
 * service-account key in particular is pasted into this file by you, by hand,
 * and nothing here ever reads its contents for any purpose but handing it to
 * Google's own library.
 */
function readEnv() {
  if (!existsSync(envFile)) return {};
  const found = {};
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=([\s\S]*)$/.exec(line.trim());
    if (match) found[match[1]] = match[2].replace(/^'([\s\S]*)'$/, '$1');
  }
  return found;
}

function writeEnv(values) {
  const body = Object.entries(values)
    .map(([key, value]) => `${key}='${String(value).replace(/'/g, "'\\''")}'`)
    .join('\n');
  writeFileSync(envFile, `${body}\n`, {mode: 0o600});
}

const env = readEnv();

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
const ask = interactive
  ? createInterface({input: process.stdin, output: process.stdout})
  : null;

async function askFor(question, {fallback, orSet}) {
  if (ask) return (await ask.question(question)).trim() || fallback || '';
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
  const chosen = await askFor('  Pick a password for Grace: ', {orSet: 'GRACE_PASSWORD'});
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
if (!env.GCP_SERVICE_ACCOUNT_JSON) {
  if (!existsSync(keyFile)) {
    ask?.close();
    fail(
      `She needs the Google service-account key to think.\n\n` +
        `Save the JSON file you downloaded from Google Cloud as:\n\n` +
        `  ${keyFile}\n\n` +
        `It is the same file you pasted into Vercel. Then run this again.\n` +
        `Nothing reads it except Google's own library, and it never leaves this machine.`,
    );
  }
  env.GCP_SERVICE_ACCOUNT_JSON = readFileSync(keyFile, 'utf8').trim();
  say('  Found the Google key.');
}

env.GRACE_DATA_DIR ??= join(root, '.grace');
env.PORT ??= '7766';
// The voice needs a second port, because it is a socket rather than a request.
env.GRACE_VOICE_PORT ??= '8787';
env.GRACE_OUTPOST_URL ??= `ws://localhost:${env.GRACE_VOICE_PORT}/voice`;

writeEnv(env);
ask?.close();
say(`  Settings saved to .env.local — that file holds your secrets, so keep it.`);

// ---- building what needs building ------------------------------------------

function run(command, args, extra = {}) {
  const done = spawnSync(command, args, {cwd: root, stdio: 'inherit', shell: true, ...extra});
  if (done.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed.`);
}

if (!existsSync(join(root, 'node_modules'))) {
  step('Installing what she is built from (this takes a minute)');
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
const sourceAt = Math.max(newestUnder(join(root, 'src')), newestUnder(join(root, 'shared')));

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
