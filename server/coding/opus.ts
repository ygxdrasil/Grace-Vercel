import {spawn, spawnSync} from 'node:child_process';
import type {Attempt} from './types';

/**
 * The top of the ladder: Opus, through Claude Code, on this machine.
 *
 * Nothing here re-implements an agent. Claude Code is already one — it reads,
 * edits, and checks its own work — and it is already installed and already
 * signed in. This starts it, watches it, and reports what happened.
 *
 * It may edit and it may not run commands. `acceptEdits` is the line the user
 * drew: an edit can be undone, and the things that cannot go through her, in
 * front of them, with the gate in the way. It also keeps this rung and the
 * Gemini rung below reaching exactly as far as each other, which is what makes
 * escalation a change of ability rather than a change of permission.
 */

/** Longest one attempt may run. Long enough for real work, short enough to notice. */
const LONGEST_MS = 20 * 60 * 1000;

let looked: {at: number; version: string | null} | null = null;

/**
 * Is Claude Code actually on this machine?
 *
 * Checked rather than assumed, and remembered for a minute rather than for the
 * life of the process — somebody installing it while she is running should not
 * have to restart her to be told it worked.
 */
export function opusAvailable(): string | null {
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

export function runWithOpus(task: string, folder: string): Promise<Attempt> {
  const began = Date.now();

  return new Promise((done) => {
    /*
     * The task goes in on stdin, and never on the command line.
     *
     * It was an argument, and that was wrong twice over. `shell: true` is
     * needed on Windows, where `claude` is a .cmd shim that will not otherwise
     * be found on PATH — and a shell splits an unquoted argument on spaces, so
     * "write the thing" reached Claude Code as "write". Every real task is
     * more than one word, so every real task was truncated to its first.
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
        // The whole point of this rung: Opus, not whatever the default is.
        '--model',
        'opus',
        '--permission-mode',
        'acceptEdits',
      ],
      {cwd: folder, shell: true, env: process.env},
    );

    child.stdin.on('error', () => {
      // It exited before reading the task. The close handler has the reason;
      // an unhandled EPIPE here would take the whole process down with it.
    });
    child.stdin.end(task);

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));

    const timer = setTimeout(() => child.kill('SIGKILL'), LONGEST_MS);
    const seconds = () => Math.round((Date.now() - began) / 1000);

    child.on('error', (error) => {
      clearTimeout(timer);
      done({
        by: 'claude-opus-5',
        ok: false,
        handedOver: false,
        summary: `could not start Claude Code: ${error.message}`,
        seconds: seconds(),
        edited: 0,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      /*
       * The JSON result, when there is one.
       *
       * Claude Code prints one object at the end with the summary, the cost
       * and how many turns it took. A non-zero exit usually still prints it —
       * that is the difference between "it tried and reports why" and "it
       * never ran" — so this reads the output before trusting the exit code.
       */
      let parsed: {result?: string; total_cost_usd?: number; num_turns?: number} | null =
        null;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        // Not JSON: killed mid-run, or it fell over before printing anything.
      }

      done({
        by: 'claude-opus-5',
        ok: code === 0,
        handedOver: false,
        summary:
          parsed?.result ??
          (code === 0
            ? out.trim() || 'It finished without saying much.'
            : err.trim() || out.trim() || `Claude Code stopped with code ${code}.`),
        seconds: seconds(),
        // Claude Code does not report a file count, and inferring one from its
        // prose would be worse than admitting the number is not known.
        edited: code === 0 ? 1 : 0,
        ...(parsed?.total_cost_usd ? {cost: parsed.total_cost_usd} : {}),
        ...(parsed?.num_turns ? {turns: parsed.num_turns} : {}),
      });
    });
  });
}
