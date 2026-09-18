import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Her working on herself, and the rails that make that survivable.
 *
 * She is a program editing the source of the program she is running, which is
 * an unusual position and worth naming rather than glossing. Two properties
 * make it safe enough to allow, and neither is a matter of care:
 *
 * Node has already loaded the modules she is running from. Editing the files
 * on disk does not change the Grace currently answering — the change lands
 * only when she is restarted. So a bad edit cannot take her off the air
 * mid-sentence; it can only fail to start next time, which is a thing you
 * find out at a moment of your choosing.
 *
 * And nothing happens on `main`. She works on a branch she makes, leaving the
 * branch you were on exactly as it was. The worst outcome is a branch you
 * delete without reading.
 *
 * The one rule with no give in it: she will not start if the working tree is
 * dirty. Uncommitted work belongs to whoever left it there, and a coding agent
 * let loose on top of it would bury changes nobody has a copy of. Refusing is
 * the only correct behaviour and it is checked before a branch is even made.
 */

export interface Repo {
  root: string;
  branch: string;
}

/** A shell confined to the allowed folders, handed in rather than held here. */
export type Run = (command: string, folder: string) => Promise<{ok: boolean; detail: string}>;

/**
 * Where her own source is.
 *
 * Taken from the working directory and then *verified*, rather than trusted.
 * She is started from her own folder by the launcher, but "the process happens
 * to have been started somewhere" is not evidence — and the cost of being
 * wrong is a coding agent let loose on a stranger's repository. The package
 * name is the proof.
 */
export function herOwnRepo(): string | null {
  const here = process.cwd();
  const manifest = join(here, 'package.json');
  if (!existsSync(manifest)) return null;

  try {
    const named = JSON.parse(readFileSync(manifest, 'utf8')) as {name?: string};
    if (named.name !== 'grace') return null;
  } catch {
    return null;
  }

  return existsSync(join(here, '.git')) ? here : null;
}

/**
 * A branch name from a sentence.
 *
 * Built out of nothing but letters, digits and hyphens. The task it is named
 * after is written by a language model and lands in a git command, so the
 * alphabet is the defence — there is no quoting to get right if there is
 * nothing in it that a shell could read.
 */
export function branchFor(task: string, now = new Date()): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');

  const stamp = now.toISOString().slice(5, 16).replace(/[-:T]/g, '');
  return `grace/${words || 'work'}-${stamp}`;
}

export interface Prepared {
  ok: boolean;
  why?: string;
  repo?: Repo;
}

/**
 * Everything that must be true before she touches her own code.
 *
 * In this order deliberately: each step's failure is cheaper than the next
 * one's, and none of them creates anything until all of the checks have
 * passed. A branch made and then abandoned because of a check that could have
 * run first is clutter somebody has to understand later.
 */
export async function prepare(task: string, run: Run): Promise<Prepared> {
  const root = herOwnRepo();
  if (!root) {
    return {
      ok: false,
      why:
        'I cannot find my own source from here — this is not a git checkout of ' +
        'Grace. Say that plainly rather than working somewhere else.',
    };
  }

  const dirty = await run('git status --porcelain', root);
  if (!dirty.ok) return {ok: false, why: `I could not read git here: ${dirty.detail}`};
  if (dirty.detail.trim()) {
    return {
      ok: false,
      why:
        'There are uncommitted changes in my own folder. I will not work on ' +
        'top of them — they belong to whoever left them there, and a coding ' +
        'agent would bury them. Ask the user to commit or stash first. What ' +
        `is outstanding:\n\n${dirty.detail.trim()}`,
    };
  }

  const branch = branchFor(task);
  const made = await run(`git checkout -b ${branch}`, root);
  if (!made.ok) return {ok: false, why: `I could not make a branch: ${made.detail}`};

  return {ok: true, repo: {root, branch}};
}

/** What changed, in the form a person would want to see it. */
export async function summarise(repo: Repo, run: Run): Promise<string> {
  const changed = await run('git status --porcelain', repo.root);
  const counted = await run('git diff --stat', repo.root);

  if (!changed.detail.trim()) {
    return `Nothing was changed on ${repo.branch}. The branch is empty.`;
  }

  return (
    `On branch ${repo.branch}:\n\n${counted.detail.trim() || changed.detail.trim()}\n\n` +
    `Nothing is committed and nothing is merged. To look at it: ` +
    `\`git diff\`. To keep it: \`git add -A && git commit\`. To throw it away: ` +
    `\`git checkout main && git branch -D ${repo.branch}\`.`
  );
}
