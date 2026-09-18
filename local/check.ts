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
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
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

console.log(`\n${passed} checks passed.\n`);
