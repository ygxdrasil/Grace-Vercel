import {awaitResult, bridgeStatus, enqueue} from '../bridge';
import type {BridgeAction} from '../bridge';
import type {Tool} from './types';

/**
 * Her hands on the user's own computer.
 *
 * Grace runs in a data centre and the files are not there. The bridge already
 * solved the hard half of that problem for the living room — a small program on
 * the machine that dials out to her, so nothing at home listens on a port and
 * there is no router to reconfigure — and the same channel carries this. An
 * instruction only ever exists because the machine went and asked for one.
 *
 * What stops her doing damage is not this file. It is two things underneath it:
 * the gate, which holds anything destructive until the user has said yes in
 * their own words, and the bridge, which refuses a path outside the folders the
 * user listed no matter what arrived over the wire. Both had to be true
 * separately, because either one alone is a single point of failure on
 * somebody's home directory.
 */

const NO_BRIDGE =
  'The bridge is not running on the user’s machine, so I cannot reach their ' +
  'files or their shell at all. Say exactly that — the program has to be ' +
  'started on the computer itself — and do not imply anything happened.';

/**
 * How long to wait, per kind of instruction.
 *
 * A directory listing comes back in the time it takes the machine to notice
 * it was asked. A command might genuinely take half a minute, and being told
 * "it has not reported back" when it is still compiling is useless.
 *
 * Every one of these has to clear the machine's own idle poll before it can
 * clear anything else: the first instruction after a quiet spell waits to be
 * noticed, and only then starts. Anything under about ten seconds would time
 * out on the first question of every conversation and succeed on all the rest,
 * which is the most confusing possible way for this to be wrong.
 */
const PATIENCE: Partial<Record<BridgeAction, number>> = {
  shell: 45_000,
  ls: 20_000,
  read: 25_000,
  write: 25_000,
  remove: 25_000,
};

async function ask(
  action: BridgeAction,
  arg: string,
  extra: {body?: string; replace?: boolean} = {},
): Promise<string> {
  const {online} = await bridgeStatus();
  if (!online) return NO_BRIDGE;

  const id = await enqueue(action, arg, extra);
  const finished = await awaitResult(id, PATIENCE[action] ?? 12_000);

  if (!finished) {
    return (
      'The machine took the instruction but has not reported back yet. Say it ' +
      'is still going rather than that it is done, and offer to check again.'
    );
  }

  if (!finished.ok) {
    return `That did not work: ${finished.detail || 'the machine gave no reason'}.`;
  }

  return finished.detail || 'Done.';
}

/**
 * Commands that can destroy something, as a question rather than a claim.
 *
 * This is a filter, not a proof, and the difference matters enough to write
 * down: anything here can be expressed in a way this does not match — a python
 * one-liner, a script whose name says nothing, a variable holding the path. It
 * is why the gate is not the only protection and why the bridge keeps its own
 * boundary. What this buys is that the obvious ways to lose a folder stop and
 * ask, which covers very nearly everything that actually happens by accident.
 *
 * Deliberately generous about what counts. A confirmation the user did not
 * need costs them a second; a deletion they did not expect costs them a day.
 */
const DESTRUCTIVE = [
  /\brm\b/, /\brmdir\b/, /\bunlink\b/, /\bshred\b/, /\btruncate\b/,
  /\bdd\b/, /\bmkfs/, /\bfdisk\b/, /\bdiskutil\b/, /\bformat\b/,
  /\bmv\b/, /\bchmod\b/, /\bchown\b/, /\bkillall\b/, /\bpkill\b/,
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/,
  /\bgit\s+(reset|clean|checkout\s+--|push\s+.*--force|push\s+.*-f\b)/,
  /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bsudo\b/, /\bsu\b/,
  /*
   * Redirection that lands on top of a file.
   *
   * Not `>>`, which appends and loses nothing, and not `2>&1`, which points
   * one stream at another and touches no file at all. The lookbehind is what
   * makes the first of those work: without it the second angle bracket of
   * `>>` is itself a `>` not followed by a `>`, so every append was read as
   * an overwrite and asked about.
   */
  /(?<!>)>(?!>)(?!\s*&)/,
];

export function looksDestructive(command: string): boolean {
  return DESTRUCTIVE.some((pattern) => pattern.test(command));
}

export const machineTools: Tool[] = [
  {
    name: 'list_folder',
    description:
      'List what is in a folder on the user’s own computer. Paths may be ' +
      'absolute or start with ~ for their home folder. Use this before ' +
      'guessing at a path — she can see the machine, so she should look.',
    parameters: {
      path: {type: 'string', description: 'The folder, e.g. ~/Documents'},
    },
    required: ['path'],
    category: 'machine',
    run: (args) => ask('ls', String(args.path)),
  },
  {
    name: 'read_file',
    description:
      'Read a text file on the user’s own computer. Large files come back ' +
      'shortened, and binary files are refused rather than mangled.',
    parameters: {
      path: {type: 'string', description: 'The file, e.g. ~/notes/todo.md'},
    },
    required: ['path'],
    category: 'machine',
    run: (args) => ask('read', String(args.path)),
  },
  {
    name: 'write_file',
    description:
      'Write a text file on the user’s own computer. Creating a new file is ' +
      'free. Landing on top of a file that already exists needs replace=true, ' +
      'and that will stop and ask the user first.',
    parameters: {
      path: {type: 'string', description: 'The file to write'},
      text: {type: 'string', description: 'The whole contents of the file'},
      replace: {
        type: 'boolean',
        description:
          'True to overwrite a file that already exists. Without it, an ' +
          'existing file is left alone and you are told so.',
      },
    },
    required: ['path', 'text'],
    category: 'machine',
    // Creating something is not destroying anything. Replacing something is.
    risky: (args) => args.replace === true,
    run: (args) =>
      ask('write', String(args.path), {
        body: String(args.text ?? ''),
        replace: args.replace === true,
      }),
  },
  {
    name: 'delete_file',
    description:
      'Delete a file on the user’s own computer. This always stops and asks ' +
      'them first — it is one of the three things they said must be confirmed.',
    parameters: {
      path: {type: 'string', description: 'The file to delete'},
    },
    required: ['path'],
    category: 'machine',
    destructive: true,
    run: (args) => ask('remove', String(args.path)),
  },
  {
    name: 'run_command',
    description:
      'Run a command in the terminal on the user’s own computer and return ' +
      'what it printed. Anything that could destroy something — deleting, ' +
      'moving, overwriting, sudo — stops and asks them first. Prefer the ' +
      'plainest command that answers the question.',
    parameters: {
      command: {type: 'string', description: 'The command line to run'},
      folder: {
        type: 'string',
        description: 'Which folder to run it in. Defaults to their home folder.',
      },
    },
    required: ['command'],
    category: 'machine',
    risky: (args) => looksDestructive(String(args.command ?? '')),
    run: (args) =>
      ask('shell', String(args.command), {
        body: args.folder ? String(args.folder) : undefined,
      }),
  },
];
