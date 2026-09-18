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
 * The coding agent, against a stand-in for Claude Code.
 *
 * Deliberately not the real thing. What is being proved here is the wiring —
 * that a job starts, that its result and its cost come back, that a refusal
 * is reported as a refusal, and that a folder outside the allowed ones is
 * refused before anything runs. Every one of those is ours to get wrong.
 * Whether Claude Code can write a linked list is not.
 */
console.log('\nthe coding agent');

const bin = mkdtempSync(join(tmpdir(), 'grace-bin-'));
const fake = join(bin, 'claude');
writeFileSync(
  fake,
  [
    '#!/usr/bin/env node',
    // Only the two shapes the caller actually depends on: --version, and a
    // headless run that ends with one JSON object.
    'if (process.argv.includes("--version")) { console.log("2.0.0 (stand-in)"); process.exit(0); }',
    // The task arrives on stdin, exactly as the real one takes it.
    'let task = "";',
    'process.stdin.on("data", (c) => (task += c));',
    'process.stdin.on("end", () => {',
    '  if (task.includes("fail")) { console.log(JSON.stringify({result: "I could not do that.", total_cost_usd: 0.01, num_turns: 1})); process.exit(1); }',
    '  require("fs").writeFileSync("touched-by-opus.txt", task);',
    '  console.log(JSON.stringify({result: "Done: " + task, total_cost_usd: 0.42, num_turns: 7}));',
    '});',
  ].join('\n'),
  {mode: 0o755},
);
process.env.PATH = `${bin}:${process.env.PATH}`;

const {recentJobs} = await import('../server/coding');
const {spend} = await import('../server/budget');

/** Coding is asynchronous on purpose, so the checks have to wait for it. */
async function settled(id: string) {
  for (let tries = 0; tries < 100; tries += 1) {
    const job = recentJobs().find((one) => one.id === id);
    if (job?.finishedAt) return job;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error('the job never finished');
}

await check('refuses a folder outside the allowed ones before starting', async () => {
  const out = await runTool({name: 'write_code', args: {task: 'anything', folder: '/etc'}});
  assert.match(out.result, /outside the folders/);
  assert.equal(recentJobs().length, 0, 'and nothing was set going');
});

await check('starts a job and comes straight back', async () => {
  const began = Date.now();
  const out = await runTool({
    name: 'write_code',
    args: {task: 'write the thing', folder: root},
  });
  assert.equal(out.ok, true, out.result);
  assert.match(out.result, /Started/);
  assert.ok(Date.now() - began < 3000, 'starting must not block on the work');
});

await check('reports the result, the cost and the steps when it finishes', async () => {
  const job = await settled(recentJobs()[0].id);
  assert.equal(job.ok, true);
  assert.equal(job.cost, 0.42);
  assert.equal(job.turns, 7);
  const out = await runTool({name: 'check_code', args: {}});
  assert.match(out.result, /finished/);
  assert.match(out.result, /Done: write the thing/);
  assert.match(out.result, /\$0\.42/);
});

await check('and it really did edit a file in that folder', async () => {
  assert.equal(readFileSync(join(root, 'touched-by-opus.txt'), 'utf8'), 'write the thing');
});

await check('the cost lands on the card, never on the Google credit', async () => {
  const money = await spend();
  assert.ok(
    (money.byModel?.['claude-opus-5 (coding)'] ?? 0) >= 0.42,
    'the coding spend is recorded against its own line',
  );
  assert.equal(money.pool ?? 0, 0, 'and has not touched the promotional credit');
});

await check('a task full of shell syntax arrives as text, not as commands', async () => {
  /*
   * The task is written by a language model from whatever was said to her, so
   * it is exactly the kind of string that must never reach a shell. This one
   * would create a file if any of it were executed, and its own words would
   * be lost to word-splitting if it were an unquoted argument. Both are
   * checked at once: the file must not exist, and the task must arrive whole.
   */
  const nasty = 'add a $(touch pwned) note; echo `whoami` && rm -rf . || true';
  const started = await runTool({name: 'write_code', args: {task: nasty, folder: root}});
  const id = /Job (\w+)/.exec(started.result)?.[1];
  await settled(id);

  assert.equal(
    readFileSync(join(root, 'touched-by-opus.txt'), 'utf8'),
    nasty,
    'the task must arrive exactly as written, not split on spaces',
  );
  assert.equal(existsSync(join(root, 'pwned')), false, 'and none of it may have run');
});

await check('a job that fails is reported as failed, not as done', async () => {
  const started = await runTool({
    name: 'write_code',
    args: {task: 'something it will fail at', folder: root},
  });
  const id = /Job (\w+)/.exec(started.result)?.[1];
  assert.ok(id, 'the job id is in the reply');
  const job = await settled(id);
  assert.equal(job.ok, false);
  const out = await runTool({name: 'check_code', args: {id}});
  assert.match(out.result, /failed/);
  assert.match(out.result, /could not do that/);
});

console.log(`\n${passed} checks passed.\n`);
