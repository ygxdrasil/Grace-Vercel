import type {CodingHands} from './index';

/**
 * Running the project's own tests, and what that is for.
 *
 * Code that has not been run is a draft. Neither rung of the ladder can run
 * anything — that is the line the user drew, and it stays drawn — so this is
 * the ladder itself doing it, between attempts, and handing the failures back
 * as the next instruction. That turns "it wrote something" into "it wrote
 * something that passes", which is the only version worth having.
 *
 * The command is never read out of a file.
 *
 * That is the whole security design here and it is worth stating on its own.
 * It would be natural to read `scripts.test` out of package.json and run
 * whatever it says — and that is a string in a file in a folder, which anything
 * that has ever written to that folder controls, including the coding model
 * that just edited it. So the command is chosen from a fixed list below by
 * looking at which files exist, and nothing from inside any of them is ever
 * interpolated into it. What runs is one of seven literals or nothing.
 *
 * What remains true and cannot be designed away: running a project's tests runs
 * the project's code. Anyone who can put a file in that folder can make that
 * code do anything. That is what a test suite is, it is the same exposure as
 * typing `npm test` yourself, and it is why the folders she may touch are the
 * boundary that actually matters.
 */

/** A marker file, and the one literal command it implies. */
const SUITES: {needs: string; command: string; also?: string}[] = [
  // Ordered by how specific the evidence is. A lockfile says which package
  // manager is actually in use; package.json alone only says it is Node.
  {needs: 'pnpm-lock.yaml', command: 'pnpm test'},
  {needs: 'yarn.lock', command: 'yarn test'},
  {needs: 'package-lock.json', command: 'npm test'},
  {needs: 'package.json', command: 'npm test'},
  {needs: 'Cargo.toml', command: 'cargo test'},
  {needs: 'go.mod', command: 'go test ./...'},
  {needs: 'pyproject.toml', command: 'pytest'},
  {needs: 'pytest.ini', command: 'pytest'},
  {needs: 'Makefile', command: 'make test'},
];

export interface TestRun {
  command: string;
  passed: boolean;
  output: string;
  seconds: number;
}

/**
 * Which suite this folder has, if any.
 *
 * Decided from a directory listing rather than by reading anything, so a file's
 * contents cannot influence what gets run.
 */
export async function findSuite(
  folder: string,
  hands: CodingHands,
): Promise<string | null> {
  const listing = await hands('ls', folder);
  // The listing is one name per line, with a trailing slash on folders.
  const names = new Set(
    listing
      .split('\n')
      .map((line) => line.split(/\s{2,}/)[0].trim().replace(/\/$/, ''))
      .filter(Boolean),
  );

  for (const suite of SUITES) {
    if (names.has(suite.needs)) return suite.command;
  }
  return null;
}

/** Enough of a failure to act on. Whole suites of output help nobody. */
const MOST_OUTPUT = 6000;

/**
 * The tail, not the head.
 *
 * A failing suite prints its passes first and its failures last, so the first
 * six thousand characters of a long run are the part nobody needs. Trimming
 * from the wrong end is a quiet way to hand a model a page of green ticks and
 * ask it why something is broken.
 */
function lastOf(text: string, limit = MOST_OUTPUT): string {
  if (text.length <= limit) return text;
  return `[...earlier output not shown...]\n${text.slice(-limit)}`;
}

export async function runSuite(
  folder: string,
  command: string,
  shell: (command: string, folder: string) => Promise<{ok: boolean; detail: string}>,
): Promise<TestRun> {
  const began = Date.now();
  const outcome = await shell(command, folder);

  return {
    command,
    passed: outcome.ok,
    output: lastOf(outcome.detail.trim()),
    seconds: Math.round((Date.now() - began) / 1000),
  };
}

/**
 * What the next attempt is told when the tests said no.
 *
 * Written as the failure first and the original job second, because that is
 * the order it matters in: the job is already done as far as the previous
 * attempt was concerned, and what is actually being asked now is to make this
 * output go away without undoing the work.
 */
export function failureBrief(task: string, run: TestRun): string {
  return (
    `The code in this folder was just changed, and the tests now fail.\n\n` +
    `\`${run.command}\` said:\n\n${run.output}\n\n` +
    `Fix it. Read the files before changing them — the folder is not in the ` +
    `state it was when the work started. Do not undo the change that was ` +
    `being made; make it work.\n\n---\n\nThe original job was:\n\n${task}`
  );
}
