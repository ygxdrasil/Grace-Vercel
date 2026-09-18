import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {recordOutside} from './budget';

/**
 * Opus, working on code, on the machine she is running on.
 *
 * She is a good assistant and an indifferent programmer, and those are not the
 * same job. This hands the programming to something built for it rather than
 * pretending otherwise: Claude Code, already installed on the machine, already
 * signed in, already an agent with a loop — reading files, editing them,
 * checking its own work. Nothing here re-implements any of that. It starts it,
 * watches it, and hands back what happened.
 *
 * Two decisions are worth stating plainly, because both are deliberate limits
 * rather than things nobody got round to.
 *
 * It runs in the background. A coding task takes minutes, and a tool call that
 * blocks for minutes means she sits mute in the middle of a sentence while the
 * user wonders whether she has crashed. So starting one returns immediately
 * and she checks on it — which is also how a person would describe it: "I've
 * set that going."
 *
 * It may edit, and it may not run commands. `acceptEdits` lets it write code
 * freely and stops it shelling out, which is the line the user drew: editing a
 * file can be undone, and the things that cannot be undone go through her, in
 * front of them, with the gate in the way. If a build needs running afterwards
 * she runs it herself and they see it happen.
 */

export interface Job {
  id: string;
  task: string;
  folder: string;
  startedAt: number;
  finishedAt?: number;
  /** Set while it runs, so a second look can report progress rather than guess. */
  ok?: boolean;
  summary?: string;
  cost?: number;
  turns?: number;
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

/** Longest a single task may run. Long enough for real work, short enough to notice. */
const LONGEST_MS = 20 * 60 * 1000;

let looked: {at: number; version: string | null} | null = null;

/**
 * Is Claude Code actually on this machine?
 *
 * Checked rather than assumed, and remembered for a minute rather than for the
 * life of the process — somebody installing it while she is running should not
 * have to restart her to be told it worked.
 */
export function codingAvailable(): string | null {
  if (looked && Date.now() - looked.at < 60_000) return looked.version;

  let version: string | null = null;
  try {
    const asked = spawnSync('claude', ['--version'], {encoding: 'utf8', shell: true});
    if (asked.status === 0) version = asked.stdout.trim() || 'installed';
  } catch {
    // Not there, not on PATH, or not runnable. All the same answer.
  }

  looked = {at: Date.now(), version};
  return version;
}

export function startJob(task: string, folder: string): Job {
  const job: Job = {id: randomUUID().slice(0, 8), task, folder, startedAt: Date.now()};
  jobs.set(job.id, job);

  /*
   * The task goes in on stdin, and never on the command line.
   *
   * It was an argument, and that was wrong twice over. `shell: true` is needed
   * on Windows, where `claude` is a .cmd shim that will not otherwise be found
   * on PATH — and a shell splits an unquoted argument on spaces, so "write the
   * thing" reached Claude Code as "write". Every real task is more than one
   * word, so every real task was being truncated to its first.
   *
   * The second reason is the one that matters. That text is written by a
   * language model from whatever was said to her, and a shell reads
   * backticks, `$(...)` and `;` as instructions. Quoting it would work until
   * the day the quoting was wrong. Not putting it on a command line at all
   * cannot be got wrong: stdin is bytes, and nothing parses them.
   */
  const child = spawn(
    'claude',
    [
      '-p',
      '--output-format',
      'json',
      // The whole point of the request: Opus, not whatever the default is.
      '--model',
      'opus',
      // Edits yes, arbitrary commands no. See the note at the top.
      '--permission-mode',
      'acceptEdits',
    ],
    {cwd: folder, shell: true, env: process.env},
  );

  child.stdin.on('error', () => {
    // It exited before reading the task. The close handler below has the
    // reason; an unhandled EPIPE here would take the whole process down.
  });
  child.stdin.end(task);

  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (err += chunk));

  const timer = setTimeout(() => child.kill('SIGKILL'), LONGEST_MS);

  child.on('error', (error) => {
    clearTimeout(timer);
    finish(job, false, `could not start Claude Code: ${error.message}`);
  });

  child.on('close', (code) => {
    clearTimeout(timer);

    /*
     * The JSON result, when there is one.
     *
     * Claude Code prints one object at the end with the summary, the cost and
     * how many turns it took. A non-zero exit usually still prints it — that
     * is the difference between "it tried and reports why" and "it never ran"
     * — so this reads the output before trusting the exit code.
     */
    let parsed: {result?: string; total_cost_usd?: number; num_turns?: number} | null =
      null;
    try {
      parsed = JSON.parse(out.trim());
    } catch {
      // Not JSON: killed mid-run, or it fell over before printing anything.
    }

    if (parsed?.total_cost_usd) {
      job.cost = parsed.total_cost_usd;
      // Anthropic's bill, not Google's credit — so it goes to the card side.
      void recordOutside('claude-opus-5 (coding)', parsed.total_cost_usd).catch(() => {});
    }
    job.turns = parsed?.num_turns;

    if (parsed?.result) return finish(job, code === 0, parsed.result);
    if (code === 0) return finish(job, true, out.trim() || 'It finished without saying much.');
    finish(
      job,
      false,
      err.trim() || out.trim() || `Claude Code stopped with code ${code}.`,
    );
  });

  return job;
}

function finish(job: Job, ok: boolean, summary: string): void {
  job.finishedAt = Date.now();
  job.ok = ok;
  // Long enough to be useful to her, short enough not to cost a fortune to
  // put in front of the model on every later turn.
  job.summary = summary.length > 4000 ? `${summary.slice(0, 4000)}\n[...]` : summary;
}
