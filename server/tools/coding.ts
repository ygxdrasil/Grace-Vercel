import {codingAvailable, jobById, recentJobs, startJob} from '../coding';
import {requireBudget} from '../budget';
import {config} from '../config';
import type {Tool} from './types';

/**
 * Handing the programming to something built for programming.
 *
 * She is a good assistant and an indifferent programmer, and those are
 * different jobs. Rather than pretend otherwise, she puts the work to Opus
 * through Claude Code — which is already an agent, already reads and edits
 * files, and already checks its own work.
 *
 * She stays in charge of everything around it: which folder, what the task is,
 * and running anything afterwards, in front of the user, through the gate that
 * everything else on their machine goes through.
 */

const NOT_HERE =
  'Claude Code is not on this machine, so there is nothing to hand the work ' +
  'to. Tell the user to install it — `npm install -g @anthropic-ai/claude-code` ' +
  'and then `claude` once to sign in — and do not imply you tried to code.';

const NOT_LOCAL =
  'Coding runs on the machine she is installed on, and this one is in a data ' +
  'centre with none of the user’s code on it. Say so plainly: the local ' +
  'install is the one that can do this.';

/** How long to wait before saying it is still going. */
function howLong(startedAt: number): string {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export const codingTools: Tool[] = [
  {
    name: 'write_code',
    description:
      'Put a programming task to Opus, which will read and edit files in a ' +
      'folder on the user’s machine. Use this for anything that means writing ' +
      'or changing code — do not try to write it yourself and paste it. It ' +
      'runs in the background and takes minutes, so say you have set it going ' +
      'and carry on; check on it with check_code. Describe the task fully, as ' +
      'you would to a colleague who cannot see this conversation: it gets the ' +
      'task and the folder and nothing else.',
    parameters: {
      task: {
        type: 'string',
        description:
          'The whole job, in plain words. Include what to build or change, ' +
          'anything about how the user wants it, and what "done" looks like.',
      },
      folder: {
        type: 'string',
        description: 'Which folder to work in, e.g. ~/projects/thing',
      },
    },
    required: ['task', 'folder'],
    category: 'machine',
    run: async (args) => {
      if (config.deployed) return NOT_LOCAL;
      if (!codingAvailable()) return NOT_HERE;

      /*
       * The brake reaches this too.
       *
       * A coding run is the most expensive single thing she can start — Opus
       * rates, for minutes, unattended — and it is billed by Anthropic rather
       * than out of the Google credit, so it lands on the card directly. The
       * user's limit is a limit on what she spends, not on which supplier she
       * spends it with, and a brake with a hole in it shaped like the most
       * expensive action is not a brake.
       */
      try {
        await requireBudget();
      } catch (stopped) {
        return (
          `${(stopped as Error).message} A coding run costs real money, so it ` +
          `is not something to start against a spent budget. Say so plainly.`
        );
      }

      /*
       * The folder is checked by her own hands before anything starts.
       *
       * Otherwise this is a way around the boundary: she cannot read a file
       * outside the allowed folders, but could set a coding agent running in
       * one. Listing it is the cheapest honest way to ask "am I allowed here,
       * and is it really there" — and it goes through the same single
       * implementation everything else does.
       */
      const folder = String(args.folder);
      const {runTool} = await import('./index');
      const looked = await runTool({name: 'list_folder', args: {path: folder}});
      if (!looked.ok || /outside the folders/.test(looked.result)) {
        return `I cannot work there. ${looked.result}`;
      }

      const job = startJob(String(args.task), folder);
      return (
        `Started. Job ${job.id}, working in ${folder}. It will take minutes, ` +
        `not seconds — tell the user it is running and what it is doing, then ` +
        `get on with the conversation. Check on it with check_code when they ` +
        `ask, or when enough time has passed that they would expect news.`
      );
    },
  },
  {
    name: 'check_code',
    description:
      'See how a coding job is getting on, or how the last one finished. ' +
      'Report what it says rather than reciting it.',
    parameters: {
      id: {
        type: 'string',
        description: 'Which job. Leave it out for the most recent one.',
      },
    },
    required: [],
    category: 'machine',
    run: async (args) => {
      if (config.deployed) return NOT_LOCAL;

      const wanted = args.id ? jobById(String(args.id)) : recentJobs()[0];
      if (!wanted) {
        return 'There are no coding jobs. Nothing has been set going this session.';
      }

      if (!wanted.finishedAt) {
        return (
          `Job ${wanted.id} is still going, ${howLong(wanted.startedAt)} in. ` +
          `It is working on: ${wanted.task}`
        );
      }

      const took = Math.round((wanted.finishedAt - wanted.startedAt) / 1000);
      const cost = wanted.cost ? `, cost $${wanted.cost.toFixed(2)}` : '';
      const turns = wanted.turns ? `, ${wanted.turns} steps` : '';

      return (
        `Job ${wanted.id} ${wanted.ok ? 'finished' : 'failed'} after ` +
        `${took} seconds${turns}${cost}, in ${wanted.folder}.\n\n${wanted.summary}\n\n` +
        `The files are changed on disk. If the user wants it built or tested, ` +
        `that is a separate thing you run yourself.`
      );
    },
  },
];
