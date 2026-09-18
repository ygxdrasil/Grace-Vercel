/**
 * The rails on her working on herself.
 *
 * Against a real git repository, because every one of these is a git fact and
 * a mock of git would only prove that the mock agrees with the code. The
 * things worth being certain of, in the order they matter:
 *
 *   - she refuses outright on a dirty tree, before making anything;
 *   - she never works on the branch the user was on;
 *   - a branch name built from a sentence cannot carry shell syntax;
 *   - she will not mistake somebody else's repository for her own.
 *
 * The last is the quiet one. "The process was started in this folder" is not
 * evidence of anything, and the cost of being wrong is a coding agent let
 * loose on a stranger's code.
 *
 *   npm run check:self
 */

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const {branchFor, herOwnRepo, prepare, summarise} = await import('../server/coding/self');

let passed = 0;
const check = async (what: string, run: () => Promise<void> | void) => {
  await run();
  passed += 1;
  console.log(`  ✓ ${what}`);
};

/** A real repository, standing in for hers. */
function makeRepo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'grace-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, {cwd: root, stdio: 'pipe'});
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'check@example.invalid');
  git('config', 'user.name', 'Check');
  writeFileSync(join(root, 'package.json'), JSON.stringify({name, version: '0.0.0'}));
  writeFileSync(join(root, 'thing.ts'), 'export const thing = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return root;
}

/** The shell the rails are handed, confined to one folder. */
const shellIn = (root: string) => async (command: string, folder: string) => {
  try {
    const out = execFileSync(command, {cwd: folder || root, shell: true, encoding: 'utf8'});
    return {ok: true, detail: out};
  } catch (error) {
    const failed = error as {stdout?: string; stderr?: string; message: string};
    return {ok: false, detail: failed.stdout || failed.stderr || failed.message};
  }
};

const here = process.cwd();

console.log('\nknowing her own source from somebody else’s');

await check('a folder that is not Grace is refused', () => {
  process.chdir(makeRepo('somebody-elses-project'));
  assert.equal(herOwnRepo(), null, 'the package name is the proof, not the location');
});

await check('and her own is recognised', () => {
  const mine = makeRepo('grace');
  process.chdir(mine);
  // Compared through realpath: macOS hands out /var and means /private/var.
  assert.equal(
    readFileSync(join(herOwnRepo() ?? '', 'package.json'), 'utf8').includes('"grace"'),
    true,
  );
});

console.log('\nbranch names, built from sentences');

await check('a name is only letters, digits and hyphens', () => {
  const nasty = branchFor('fix the `rm -rf /` bug; $(whoami) && echo "oops"');
  assert.match(nasty, /^grace\/[a-z0-9-]+$/, `unsafe branch name: ${nasty}`);
  assert.ok(!nasty.includes('..'), 'and nothing git would read as a range');
});

await check('two jobs a second apart do not collide', () => {
  const first = branchFor('same words', new Date('2026-09-18T11:00:00Z'));
  const second = branchFor('same words', new Date('2026-09-18T11:47:00Z'));
  assert.notEqual(first, second);
});

await check('an unnameable task still gets a branch', () => {
  assert.match(branchFor('🙂🙂🙂'), /^grace\/work-\d+$/);
});

console.log('\nthe rails');

await check('a dirty tree stops her before anything is made', async () => {
  const root = makeRepo('grace');
  process.chdir(root);
  writeFileSync(join(root, 'thing.ts'), 'someone was in the middle of this\n');

  const ready = await prepare('tidy something up', shellIn(root));
  assert.equal(ready.ok, false);
  assert.match(ready.why ?? '', /uncommitted changes/);
  assert.match(ready.why ?? '', /thing\.ts/, 'and it says what is outstanding');

  // Nothing was created, and the work in progress is exactly as it was.
  const branches = execFileSync('git', ['branch'], {cwd: root, encoding: 'utf8'});
  assert.equal(branches.includes('grace/'), false, 'no branch was made');
  assert.match(readFileSync(join(root, 'thing.ts'), 'utf8'), /middle of this/);
});

await check('a clean tree gets a branch, and main is left where it was', async () => {
  const root = makeRepo('grace');
  process.chdir(root);

  const ready = await prepare('make the widget faster', shellIn(root));
  assert.equal(ready.ok, true, ready.why);
  assert.match(ready.repo?.branch ?? '', /^grace\/make-the-widget-faster-/);

  const on = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(on, ready.repo?.branch, 'she is on her own branch');

  // And main still points at the first commit, untouched.
  const mainAt = execFileSync('git', ['rev-parse', 'main'], {cwd: root, encoding: 'utf8'});
  const firstAt = execFileSync('git', ['rev-list', '--max-parents=0', 'main'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(mainAt.trim(), firstAt.trim(), 'main has not moved');
});

await check('what changed is reported with a way to undo it', async () => {
  const root = makeRepo('grace');
  process.chdir(root);
  const ready = await prepare('change the thing', shellIn(root));
  writeFileSync(join(root, 'thing.ts'), 'export const thing = 2;\n');

  const said = await summarise(ready.repo!, shellIn(root));
  assert.match(said, /thing\.ts/);
  assert.match(said, /Nothing is committed/);
  assert.match(said, /git checkout main/, 'and how to throw it away');
});

await check('an empty branch says so rather than implying work happened', async () => {
  const root = makeRepo('grace');
  process.chdir(root);
  const ready = await prepare('do nothing at all', shellIn(root));

  const said = await summarise(ready.repo!, shellIn(root));
  assert.match(said, /branch is empty/);
});

process.chdir(here);
console.log(`\n${passed} checks passed.\n`);
