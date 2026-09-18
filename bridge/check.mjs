/**
 * Does the boundary actually hold?
 *
 * Run on its own during development:
 *
 *   GRACE_ROOTS=/some/folder node bridge/check.mjs
 *
 * Every case here is one somebody would try, deliberately or by accident: a
 * path that climbs out with `..`, a symlink pointing somewhere else entirely,
 * an absolute path to a system file, an overwrite that was not asked for. The
 * interesting ones are the escapes, because they are the difference between a
 * boundary and a comment about one.
 */

import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'grace-bridge-'));
mkdirSync(join(root, 'notes'));
writeFileSync(join(root, 'notes', 'todo.md'), 'milk\nbread\n');
writeFileSync(join(root, 'notes', 'blob.bin'), Buffer.from([0x68, 0x00, 0x69]));
symlinkSync('/etc', join(root, 'escape'));

process.env.GRACE_ROOTS = root;
process.env.GRACE_URL = 'https://example.invalid';
process.env.GRACE_BRIDGE_TOKEN = 'not-used-here';
process.env.GRACE_BRIDGE_CHECK = '1';

const {carryOut} = await import('./bridge.mjs');

let passed = 0;
const check = async (what, run) => {
  await run();
  passed += 1;
  console.log(`  ✓ ${what}`);
};

console.log('\nthe boundary');

await check('refuses a path that climbs out with ..', async () => {
  const out = await carryOut('read', join(root, 'notes', '..', '..', '..', 'etc', 'passwd'));
  assert.equal(out.ok, false);
  assert.match(out.detail, /outside the folders/);
});

await check('refuses a symlink pointing out of the roots', async () => {
  const out = await carryOut('ls', join(root, 'escape'));
  assert.equal(out.ok, false);
  assert.match(out.detail, /outside the folders/);
});

await check('refuses an absolute path to a system file', async () => {
  const out = await carryOut('read', '/etc/hosts');
  assert.equal(out.ok, false);
});

await check('refuses to run a command outside the roots', async () => {
  const out = await carryOut('shell', 'echo hello', {body: '/etc'});
  assert.equal(out.ok, false);
  assert.match(out.detail, /outside the folders/);
});

await check('refuses to write outside the roots', async () => {
  const out = await carryOut('write', '/tmp/grace-should-not-be-here', {body: 'no'});
  assert.equal(out.ok, false);
});

console.log('\nwhat she is for');

await check('lists a folder', async () => {
  const out = await carryOut('ls', join(root, 'notes'));
  assert.equal(out.ok, true);
  assert.match(out.detail, /todo\.md/);
});

await check('reads a text file', async () => {
  const out = await carryOut('read', join(root, 'notes', 'todo.md'));
  assert.equal(out.ok, true);
  assert.match(out.detail, /milk/);
});

await check('refuses a binary file rather than mangling it', async () => {
  const out = await carryOut('read', join(root, 'notes', 'blob.bin'));
  assert.equal(out.ok, false);
  assert.match(out.detail, /binary/);
});

await check('writes a new file', async () => {
  const out = await carryOut('write', join(root, 'notes', 'new.txt'), {body: 'fresh'});
  assert.equal(out.ok, true);
  const back = await carryOut('read', join(root, 'notes', 'new.txt'));
  assert.match(back.detail, /fresh/);
});

await check('leaves an existing file alone unless told to replace it', async () => {
  const out = await carryOut('write', join(root, 'notes', 'todo.md'), {body: 'wiped'});
  assert.equal(out.ok, false);
  assert.match(out.detail, /already exists/);
  const back = await carryOut('read', join(root, 'notes', 'todo.md'));
  assert.match(back.detail, /milk/, 'the original survived');
});

await check('replaces it when it is told to', async () => {
  const out = await carryOut('write', join(root, 'notes', 'todo.md'), {
    body: 'wiped',
    replace: true,
  });
  assert.equal(out.ok, true);
});

await check('runs a command and reads back what it printed', async () => {
  const out = await carryOut('shell', 'echo standing-by', {body: root});
  assert.equal(out.ok, true);
  assert.match(out.detail, /standing-by/);
});

await check('reports a command that failed, with its output', async () => {
  const out = await carryOut('shell', 'ls /definitely-not-here', {body: root});
  assert.equal(out.ok, false);
  assert.match(out.detail, /exited with code/);
});

await check('stops a command that will not finish', async () => {
  process.env.GRACE_COMMAND_MS = '1200';
  const out = await carryOut('shell', 'sleep 30', {body: root});
  assert.equal(out.ok, false);
  assert.match(out.detail, /Stopped after/);
});

await check('deletes one file', async () => {
  const out = await carryOut('remove', join(root, 'notes', 'new.txt'));
  assert.equal(out.ok, true);
});

await check('refuses to delete a whole folder', async () => {
  const out = await carryOut('remove', join(root, 'notes'));
  assert.equal(out.ok, false);
  assert.match(out.detail, /folder/);
});

console.log(`\n${passed} checks passed.\n`);
