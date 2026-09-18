import {randomUUID} from 'node:crypto';
import {recordOutside} from '../budget';
import {runWithGemini} from './gemini';
import {opusAvailable, runWithOpus} from './opus';
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
  /** Every go that was had at it, in order. Usually one; sometimes two. */
  attempts: Attempt[];
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
  };
  jobs.set(job.id, job);
  void climb(job, hands, straightToOpus);
  return job;
}

async function climb(job: Job, hands: CodingHands, straightToOpus: boolean): Promise<void> {
  try {
    if (!straightToOpus) {
      const first = await runWithGemini(job.task, job.folder, hands);
      job.attempts.push(first);
      if (first.ok) return settle(job, true);

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

    const second = await runWithOpus(escalated(job), job.folder);
    job.attempts.push(second);
    if (second.cost) {
      // Anthropic's bill, not Google's credit, so it goes to the card side.
      void recordOutside('claude-opus-5 (coding)', second.cost).catch(() => {});
    }
    settle(job, second.ok);
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
