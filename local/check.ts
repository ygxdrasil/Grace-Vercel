/**
 * Does she actually have hands when she is running here?
 *
 * The deployed path and the local path reach the same work by completely
 * different routes — a queue somebody polls, versus a function call — and only
 * one of them is exercised by the rest of the suite. This runs the local one
 * against a real folder, through the real tool layer, so that "local" means
 * something proved rather than something configured.
 *
 *   npm run check:local
 */

import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'grace-local-'));
mkdirSync(join(root, 'notes'));
writeFileSync(join(root, 'notes', 'todo.md'), 'milk\nbread\n');

process.env.GRACE_ROOTS = root;
process.env.GRACE_BRIDGE_EMBEDDED = '1';
// Explicitly not deployed: that flag is the entire difference between her
// reaching for a queue and reaching for the disk.
delete process.env.VERCEL;
delete process.env.GRACE_DEPLOYED;

const {runTool} = await import('../server/tools/index');
const {setPolicy} = await import('../server/actions');

let passed = 0;
const check = async (what: string, run: () => Promise<void>) => {
  await run();
  passed += 1;
  console.log(`  ✓ ${what}`);
};

console.log('\nher hands, running on this machine');

await check('lists a folder with no bridge running at all', async () => {
  const out = await runTool({name: 'list_folder', args: {path: join(root, 'notes')}});
  assert.equal(out.ok, true, out.result);
  assert.match(out.result, /todo\.md/);
});

await check('reads a file', async () => {
  const out = await runTool({name: 'read_file', args: {path: join(root, 'notes', 'todo.md')}});
  assert.equal(out.ok, true, out.result);
  assert.match(out.result, /milk/);
});

await check('runs a command and reads back what it printed', async () => {
  const out = await runTool({
    name: 'run_command',
    args: {command: 'echo standing-by', folder: root},
  });
  assert.equal(out.ok, true, out.result);
  assert.match(out.result, /standing-by/);
});

await check('writes a new file, and it is really there', async () => {
  const out = await runTool({
    name: 'write_file',
    args: {path: join(root, 'notes', 'made.txt'), text: 'by her'},
  });
  assert.equal(out.ok, true, out.result);
  assert.equal(readFileSync(join(root, 'notes', 'made.txt'), 'utf8'), 'by her');
});

console.log('\nand the limits come with them');

await check('a command that could destroy something is held, not run', async () => {
  const out = await runTool({
    name: 'run_command',
    args: {command: `rm -rf ${join(root, 'notes')}`, folder: root},
  });
  assert.equal(out.ok, false);
  assert.match(out.result, /go-ahead/);
  // The folder it was aimed at is the proof: held means not run.
  assert.match(readFileSync(join(root, 'notes', 'todo.md'), 'utf8'), /milk/);
});

await check('and is still held with the machine policy set to act freely', async () => {
  await setPolicy('machine', 'never');
  const out = await runTool({name: 'delete_file', args: {path: join(root, 'notes', 'todo.md')}});
  assert.equal(out.ok, false);
  assert.match(out.result, /go-ahead/);
  assert.match(readFileSync(join(root, 'notes', 'todo.md'), 'utf8'), /milk/);
  await setPolicy('machine', 'high-risk');
});

await check('a path outside the allowed folders is refused', async () => {
  const out = await runTool({name: 'read_file', args: {path: '/etc/hosts'}});
  assert.equal(out.ok, true, 'the tool ran');
  assert.match(out.result, /outside the folders/, 'and refused the path');
});


/*
 * The ladder: Gemini first, Opus when that is not enough.
 *
 * Both rungs are stood in for, and deliberately. What is ours to get wrong is
 * the wiring — when it escalates, what it carries across, which side of the
 * bill each rung lands on, and whether a task made of shell syntax can escape
 * onto a command line. Whether either model can write a linked list is not.
 *
 * Opus is a fake `claude` on PATH. Gemini is a scripted provider, so each
 * check can say exactly what the cheap rung does and watch what follows.
 */
console.log('\nthe coding ladder');

const bin = mkdtempSync(join(tmpdir(), 'grace-bin-'));
writeFileSync(
  join(bin, 'claude'),
  [
    '#!/usr/bin/env node',
    // The two shapes the caller actually depends on: --version, and a headless
    // run that ends with one JSON object.
    'if (process.argv.includes("--version")) { console.log("2.0.0 (stand-in)"); process.exit(0); }',
    // The task arrives on stdin, exactly as the real one takes it.
    'let task = "";',
    'process.stdin.on("data", (c) => (task += c));',
    'process.stdin.on("end", () => {',
    '  if (task.includes("defeat opus")) { console.log(JSON.stringify({result: "I could not do that either.", total_cost_usd: 0.01, num_turns: 1})); process.exit(1); }',
    '  require("fs").writeFileSync("touched-by-opus.txt", task);',
    '  console.log(JSON.stringify({result: "Done: " + task, total_cost_usd: 0.42, num_turns: 7}));',
    '});',
  ].join('\n'),
  {mode: 0o755},
);
process.env.PATH = `${bin}:${process.env.PATH}`;

const {recentJobs} = await import('../server/coding/index');
const {spend} = await import('../server/budget');
const {setProvider} = await import('../server/llm/index');

/**
 * A Gemini that does exactly what a check tells it to.
 *
 * `complete` is the only method the coding rung uses, so the rest can throw —
 * a stub that quietly returns something plausible for a method nobody meant to
 * call is how a test ends up proving the wrong thing.
 */
type Move =
  | {call: 'look' | 'read'; path: string}
  | {call: 'write'; path: string; text: string}
  | {call: 'hand_over'; why: string};

function gemini(moves: Move[], lastWords = 'I made the change.') {
  setProvider({
    name: 'scripted',
    model: 'gemini-3.1-pro',
    async complete(request: {
      onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
    }) {
      for (const move of moves) {
        const {call, ...args} = move;
        await request.onToolCall?.(call, args as Record<string, unknown>);
      }
      return lastWords;
    },
    stream() {
      throw new Error('the coding rung must not stream');
    },
    transcribe() {
      throw new Error('not part of coding');
    },
    speak() {
      throw new Error('not part of coding');
    },
  } as never);
}

/** What has reached the card so far, so the checks can measure a change. */
const onTheCard = async () => (await spend()).card ?? 0;
const cardBefore = await onTheCard();
const poolBefore = (await spend()).pool ?? 0;

/** Coding is asynchronous on purpose, so the checks have to wait for it. */
async function settled(id: string | undefined) {
  for (let tries = 0; tries < 200; tries += 1) {
    const job = recentJobs().find((one) => one.id === id);
    if (job?.finishedAt) return job;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  throw new Error('the job never finished');
}

/** Starts a job and waits it out, which is what every check below wants. */
async function code(args: Record<string, unknown>) {
  const started = await runTool({name: 'write_code', args: {folder: root, ...args}});
  const id = /Job (\w+)/.exec(started.result)?.[1];
  return {started, job: await settled(id), id};
}

await check('refuses a folder outside the allowed ones before starting', async () => {
  const out = await runTool({name: 'write_code', args: {task: 'anything', folder: '/etc'}});
  assert.match(out.result, /outside the folders/);
  assert.equal(recentJobs().length, 0, 'and nothing was set going');
});

await check('starts a job and comes straight back', async () => {
  gemini([{call: 'write', path: join(root, 'first.txt'), text: 'by gemini'}]);
  const began = Date.now();
  const out = await runTool({name: 'write_code', args: {task: 'small job', folder: root}});
  assert.equal(out.ok, true, out.result);
  assert.match(out.result, /Started/);
  assert.ok(Date.now() - began < 3000, 'starting must not block on the work');
  await settled(/Job (\w+)/.exec(out.result)?.[1]);
});

await check('the cheap rung does the work, and Opus is never woken', async () => {
  assert.equal(readFileSync(join(root, 'first.txt'), 'utf8'), 'by gemini');
  const job = recentJobs()[0];
  assert.equal(job.ok, true);
  assert.equal(job.attempts.length, 1, 'one attempt is all it should have taken');
  assert.equal(job.attempts[0].by, 'gemini-3.1-pro');
  // Measured as a change rather than a total: the store outlives a run, and a
  // check that only passes on an empty one is a check that rots quietly.
  assert.equal(await onTheCard(), cardBefore, 'and nothing reached the card');
});

await check('handing over escalates, and carries the notes across', async () => {
  gemini([
    {call: 'read', path: join(root, 'notes', 'todo.md')},
    {call: 'hand_over', why: 'the build system here is beyond me'},
  ]);
  const {job} = await code({task: 'something subtle'});

  assert.equal(job.attempts.length, 2, 'it climbed');
  assert.equal(job.attempts[0].handedOver, true);
  assert.equal(job.attempts[1].by, 'claude-opus-5');
  assert.equal(job.ok, true);

  // What Opus was actually handed — the fake writes its whole prompt to disk.
  const handed = readFileSync(join(root, 'touched-by-opus.txt'), 'utf8');
  assert.match(handed, /something subtle/, 'the original task survives');
  assert.match(handed, /beyond me/, 'and so does what the first one learned');
  assert.match(handed, /do not assume the folder is untouched/);
});

await check('finishing without editing anything counts as not finishing', async () => {
  // The dangerous case: it says it is done, having changed nothing at all.
  gemini([{call: 'look', path: root}], 'All done, everything looks correct already.');
  const {job} = await code({task: 'the quietly skipped job'});

  assert.equal(job.attempts.length, 2, 'a job that edited nothing must escalate');
  assert.match(job.attempts[0].summary, /without changing any files/);
  assert.equal(job.ok, true);
});

await check('the bill is split by supplier: credit below, card above', async () => {
  const money = await spend();
  assert.ok(
    (await onTheCard()) >= cardBefore + 0.84,
    'both Opus runs reached the card',
  );
  assert.ok(
    (money.byModel?.['claude-opus-5 (coding)'] ?? 0) >= 0.84,
    'on their own line, so the bill can be explained',
  );
  assert.equal(money.pool ?? 0, poolBefore, 'and none of it touched the credit');
});

await check('`hard` skips the cheap rung entirely', async () => {
  gemini([{call: 'write', path: join(root, 'never.txt'), text: 'should not happen'}]);
  const {job} = await code({task: 'a whole feature', hard: true});

  assert.equal(job.attempts.length, 1);
  assert.equal(job.attempts[0].by, 'claude-opus-5');
  assert.equal(existsSync(join(root, 'never.txt')), false, 'the cheap rung never ran');
});

await check('a task full of shell syntax arrives as text, not as commands', async () => {
  /*
   * The task is written by a language model from whatever was said to her, so
   * it is exactly the kind of string that must never reach a shell. This one
   * would create a file if any of it were executed, and its own words would be
   * lost to word-splitting if it were an unquoted argument. Both are checked
   * at once: the file must not exist, and the task must arrive whole.
   */
  const nasty = 'add a $(touch pwned) note; echo `whoami` && rm -rf . || true';
  await code({task: nasty, hard: true});

  assert.match(
    readFileSync(join(root, 'touched-by-opus.txt'), 'utf8'),
    /\$\(touch pwned\)/,
    'the task must arrive as written, not split or interpreted',
  );
  assert.equal(existsSync(join(root, 'pwned')), false, 'and none of it may have run');
});

await check('both rungs failing is reported as failure, not as done', async () => {
  gemini([{call: 'hand_over', why: 'no idea'}]);
  const {job} = await code({task: 'something that will defeat opus too'});

  assert.equal(job.attempts.length, 2);
  assert.equal(job.ok, false);
  const out = await runTool({name: 'check_code', args: {id: job.id}});
  assert.match(out.result, /did not work out/);
  assert.match(out.result, /could not do that either/);
  assert.match(out.result, /may have been changed/, 'and it does not promise a clean folder');
});

await check('the coding model gets no shell and no way to delete', async () => {
  /*
   * The one thing that makes routing past the confirmation gate defensible.
   * It is handed ls, read and write and nothing else, so there is no
   * unconfirmable action available to it to be unconfirmed.
   */
  let refused = '';
  gemini([{call: 'run_command' as never, path: 'rm -rf /'} as never]);
  const {job} = await code({task: 'try to get a shell'});
  refused = job.attempts[0].summary;
  assert.ok(refused.length > 0, 'it gets an answer rather than a crash');
  assert.equal(existsSync(join(root, 'notes', 'todo.md')), true, 'and nothing was destroyed');
});

console.log(`\n${passed} checks passed.\n`);
