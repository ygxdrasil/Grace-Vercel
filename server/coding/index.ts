import {randomUUID} from 'node:crypto';
import {recordOutside} from '../budget';
import {runWithGemini} from './gemini';
import {opusAvailable, runWithOpus} from './opus';
import {failureBrief, findSuite, runSuite, type TestRun} from './tests';
import type {Attempt} from './types';

export {opusAvailable} from './opus';
export type {Attempt} from './types';

/**
 * A coding job, and the ladder it climbs.
 *
 * Most programming asked of an assistant is small — a script that renames
 * files, a function that was nearly right, a config nobody remembers the shape
 * of — and sending all of it to the most capable model available is paying for
 * the hardest thing she might ever be asked in order to do the easiest. So the
 * first go is Gemini Pro, which comes out of the promotional credit rather than
 * the card, and Opus is what happens when that is not enough.
 *
 * "Not enough" is deliberately not left to a model's opinion of its own work.
 * Three things escalate, and each is a fact rather than a judgement:
 *
 *   - it called hand_over, which it is told plainly is the right move and
 *     costs nothing;
 *   - it fell over, ran out of room, or never started;
 *   - it finished having changed no files at all.
 *
 * That last one matters more than it looks. A coding job that edited nothing
 * did not do the job, whatever the closing paragraph says — and a model asked
 * whether it succeeded will usually say yes. The cost of being wrong about it
 * is one Opus run on something already done. The cost of the other mistake is
 * telling someone their code is written when it is not.
 *
 * Both rungs reach exactly as far as each other: read and write inside the
 * folder, and no shell. Escalation buys ability, never permission.
 */

export interface Job {
  id: string;
  task: string;
  folder: string;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  /** Every go that was had at it, in order. Usually one; sometimes three. */
  attempts: Attempt[];
  /** Every run of the project's own tests, in order. */
  tested: TestRun[];
  /** Set when this job is her working on her own source, on a branch. */
  branch?: string;
  /**
   * Set when the folder has no suite to run.
   *
   * Told apart from "not tested yet" on purpose. "I could not find any tests"
   * and "the tests passed" must never look the same to somebody deciding
   * whether to trust what was written.
   */
  noSuite?: boolean;
}

/*
 * Held in memory, not on disk, and that is a real limit rather than an
 * oversight: restart her and a job in flight is orphaned — the editing it had
 * already done is on disk and safe, but she loses track of it. Worth the
 * simplicity while she is one long-lived process on somebody's desk, and worth
 * revisiting the moment that stops being true.
 */
const jobs = new Map<string, Job>();

/** Newest first, because the question is nearly always about the last one. */
export function recentJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function jobById(id: string): Job | undefined {
  return jobs.get(id);
}

export interface CodingHands {
  /** ls / read / write, already confined to the folders she is allowed. */
  (action: string, path: string, body?: string): Promise<string>;
}

export function startJob(
  task: string,
  folder: string,
  hands: CodingHands,
  {straightToOpus = false}: {straightToOpus?: boolean} = {},
): Job {
  const job: Job = {
    id: randomUUID().slice(0, 8),
    task,
    folder,
    startedAt: Date.now(),
    attempts: [],
    tested: [],
  };
  jobs.set(job.id, job);
  void climb(job, hands, straightToOpus);
  return job;
}

/**
 * Attempts allowed before she stops and says so.
 *
 * Three: the cheap one, the strong one, and one more at the strong one for
 * whatever the tests turned up. A loop that keeps going while a suite stays
 * red is a loop that spends all night and all the money on a failure it was
 * never going to fix — and the third attempt is where the useful information
 * runs out, because by then it has already seen the failure once.
 */
const MOST_ATTEMPTS = 3;

async function climb(job: Job, hands: CodingHands, straightToOpus: boolean): Promise<void> {
  try {
    if (!straightToOpus) {
      const first = await runWithGemini(job.task, job.folder, hands);
      job.attempts.push(first);
      if (first.ok && (await passes(job, hands))) return settle(job, true);

      /*
       * Nowhere to escalate to.
       *
       * Without Claude Code installed this is the only rung there is, so what
       * Gemini managed is the answer — reported as what it was, including when
       * it correctly decided the job was beyond it. Saying "failed" there
       * would be unfair to it and useless to the user.
       */
      if (!opusAvailable()) return settle(job, false);
    }

    while (job.attempts.length < MOST_ATTEMPTS) {
      const next = await runWithOpus(nextBrief(job), job.folder);
      job.attempts.push(next);
      if (next.cost) {
        // Anthropic's bill, not Google's credit, so it goes to the card side.
        void recordOutside('claude-opus-5 (coding)', next.cost).catch(() => {});
      }

      if (!next.ok) return settle(job, false);
      if (await passes(job, hands)) return settle(job, true);
    }

    // Out of attempts with the suite still red. That is a failure, and saying
    // otherwise because the last edit "succeeded" is how broken code ships.
    settle(job, false);
  } catch (error) {
    job.attempts.push({
      by: 'the ladder itself',
      ok: false,
      handedOver: false,
      summary: `something went wrong running it: ${(error as Error).message}`,
      seconds: 0,
      edited: 0,
    });
    settle(job, false);
  }
}

/**
 * Runs the project's own tests, and says whether to stop here.
 *
 * Code that has not been run is a draft, so an attempt that "succeeded" has
 * only got as far as changing files. The suite is what turns that into an
 * answer — and a folder with no suite gets an honest "there was nothing to
 * run" rather than a green tick it did not earn.
 */
async function passes(job: Job, hands: CodingHands): Promise<boolean> {
  const command = await findSuite(job.folder, hands).catch(() => null);
  if (!command) {
    job.noSuite = true;
    return true;
  }

  const run = await runSuite(job.folder, command, (cmd, folder) => shellFor(folder, cmd));
  job.tested.push(run);
  return run.passed;
}

/**
 * The one place a command is actually run, and only ever a literal one.
 *
 * Set by the caller, because the ladder has no business holding a shell of its
 * own: everything else it does goes through the same hands as the rest of her,
 * and this should too.
 */
let shellFor: (folder: string, command: string) => Promise<{ok: boolean; detail: string}> =
  async () => ({ok: false, detail: 'no way to run anything was given to the ladder'});

export function useShell(
  run: (folder: string, command: string) => Promise<{ok: boolean; detail: string}>,
): void {
  shellFor = run;
}

/**
 * What the next attempt is told.
 *
 * Failing tests take precedence over everything else, because they are the
 * most specific thing anyone knows: a suite naming the line it broke on is
 * worth more than any description of the original job.
 */
function nextBrief(job: Job): string {
  const red = job.tested[job.tested.length - 1];
  if (red && !red.passed) return failureBrief(job.task, red);
  return escalated(job);
}

/**
 * What Opus is told, when it is picking something up rather than starting it.
 *
 * The first attempt's notes are the most valuable thing produced by a failed
 * run and were being thrown away. Somebody who has already read the files and
 * found out where the difficulty is has done real work, even if they could not
 * finish — passing that on is the difference between a second attempt and the
 * same first attempt made twice.
 *
 * The warning about a half-finished edit is not decoration. The cheaper rung
 * may have written files before giving up, so the folder is not necessarily in
 * the state the task describes, and an agent assuming otherwise will make it
 * worse.
 */
function escalated(job: Job): string {
  const before = job.attempts[job.attempts.length - 1];
  if (!before) return job.task;

  return (
    `${job.task}\n\n---\n\n` +
    `A smaller model tried this first and did not finish. ` +
    `${before.handedOver ? 'It handed over, saying' : 'It failed:'} ` +
    `"${before.summary}"\n\n` +
    `It wrote ${before.edited} file${before.edited === 1 ? '' : 's'} before stopping, ` +
    `so do not assume the folder is untouched — check the current state of ` +
    `anything you are about to change rather than trusting either its account ` +
    `or the task description.`
  );
}

function settle(job: Job, ok: boolean): void {
  job.finishedAt = Date.now();
  job.ok = ok;
}
