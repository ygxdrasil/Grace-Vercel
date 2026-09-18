import {spawn} from 'node:child_process';

/**
 * Asking Opus a question, rather than setting it to work.
 *
 * The coding ladder answers "make this change". This answers "how should I go
 * about this" — a second opinion on an approach, a read of why something is
 * behaving oddly, a sanity check before an hour is spent the wrong way. The
 * difference is not a detail: one ends with the folder changed and the other
 * ends with a paragraph, and conflating them is how a question becomes an
 * edit nobody asked for.
 *
 * So nothing here may write. `--allowedTools` is set to the three that only
 * look, which is the difference between a promise in a prompt and a property
 * of the process: a model cannot be talked into using a tool it was not given.
 * It can still read the folder, which is most of what makes the answer worth
 * having — an opinion about code is worth very little from something that has
 * not seen it.
 *
 * No API key is involved anywhere in this. It goes through the Claude Code
 * already installed and already signed in, so there is no credential on the
 * machine for anything to leak, and nothing to rotate when something does.
 */

/** Long enough to read a codebase and think; short enough to not hang a conversation. */
const LONGEST_MS = 5 * 60 * 1000;

export interface Answer {
  ok: boolean;
  text: string;
  seconds: number;
  cost?: number;
}

export function askOpus(question: string, folder: string): Promise<Answer> {
  const began = Date.now();

  return new Promise((done) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--output-format',
        'json',
        '--model',
        'opus',
        /*
         * Reading only, enforced by what it holds rather than what it is told.
         *
         * If this flag is ever wrong — renamed, resyntaxed — the failure is
         * loud: Claude Code rejects the argument and the tool reports it,
         * rather than quietly running with everything available. That is the
         * right way round for a restriction to break.
         */
        '--allowedTools',
        'Read,Glob,Grep',
      ],
      {cwd: folder, shell: true, env: process.env},
    );

    // The question goes in on stdin for the same reason the coding task does:
    // it is model-written text, and a shell reads backticks as instructions.
    child.stdin.on('error', () => {});
    child.stdin.end(question);

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));

    const timer = setTimeout(() => child.kill('SIGKILL'), LONGEST_MS);
    const seconds = () => Math.round((Date.now() - began) / 1000);

    child.on('error', (error) => {
      clearTimeout(timer);
      done({ok: false, text: `could not start Claude Code: ${error.message}`, seconds: seconds()});
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      let parsed: {result?: string; total_cost_usd?: number} | null = null;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        // Not JSON: killed, or it fell over before printing anything.
      }

      done({
        ok: code === 0 && Boolean(parsed?.result),
        text:
          parsed?.result ??
          err.trim() ??
          out.trim() ??
          `Claude Code stopped with code ${code}.`,
        seconds: seconds(),
        ...(parsed?.total_cost_usd ? {cost: parsed.total_cost_usd} : {}),
      });
    });
  });
}
