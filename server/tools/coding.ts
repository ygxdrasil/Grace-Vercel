import {jobById, opusAvailable, recentJobs, startJob} from '../coding/index';
import {requireBudget} from '../budget';
import {config} from '../config';
import type {Tool} from './types';

/**
 * Handing the programming to something built for programming.
 *
 * She is a good assistant and an indifferent programmer, and those are
 * different jobs. Rather than pretend otherwise she puts the work to a model
 * that codes — Gemini Pro first, which comes out of the credit she already
 * has, and Opus when that is not enough.
 *
 * She stays in charge of everything around it: which folder, what the task is,
 * and running anything afterwards, in front of the user, through the gate that
 * everything else on their machine goes through.
 */

const NOT_LOCAL =
  'Coding runs on the machine she is installed on, and this one is in a data ' +
  'centre with none of the user’s code on it. Say so plainly: the local ' +
  'install is the one that can do this.';

/** How long a job has been going, in words rather than a count of seconds. */
function howLong(startedAt: number): string {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export const codingTools: Tool[] = [
  {
    name: 'write_code',
    description:
      'Put a programming task to a coding model, which will read and edit ' +
      'files in a folder on the user’s machine. Use this for anything that ' +
      'means writing or changing code — do not write it yourself and paste ' +
      'it. It runs in the background and takes minutes, so say you have set ' +
      'it going and carry on; check on it with check_code. Describe the task ' +
      'fully, as you would to a colleague who cannot see this conversation: ' +
      'it gets the task and the folder and nothing else.',
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
      hard: {
        type: 'boolean',
        description:
          'True to go straight to the strongest model, skipping the cheaper ' +
          'first attempt. Only for jobs that are plainly large or subtle — a ' +
          'whole feature, a tricky refactor, something already attempted and ' +
          'got wrong. Ordinary work should be left to find its own level: it ' +
          'escalates by itself when it needs to, and that costs almost nothing.',
      },
    },
    required: ['task', 'folder'],
    category: 'machine',
    run: async (args) => {
      if (config.deployed) return NOT_LOCAL;

      /*
       * The brake reaches this too.
       *
       * A coding run is the most expensive single thing she can start — minutes
       * of a large model, unattended. The cheap rung comes out of the Google
       * credit and the expensive one lands on the card, and the user's limit is
       * a limit on what she spends rather than on which supplier she spends it
       * with. A brake with a hole in it shaped like the most expensive action
       * is not a brake.
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
       * Otherwise this is the way around the boundary: she cannot read a file
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

      /*
       * The coding model's hands, which are hers with two things taken away.
       *
       * Routed past the confirmation gate on purpose, and it is worth being
       * exact about why that is not a hole. The gate exists to put a person in
       * front of anything that cannot be undone; what is handed over here is
       * only ls, read and write, so there is nothing for a person to be in
       * front of. Deleting is not offered to it at all, and neither is a
       * shell — the two things it would need to do harm are the two things it
       * does not have. The boundary on which folders it may touch is
       * untouched: every call still goes through the same one implementation.
       */
      const {carryOut} = await import('../../bridge/bridge.mjs');
      const hands = async (action: string, path: string, body?: string) => {
        const done = await carryOut(action, path, {body, replace: true});
        return done.detail;
      };

      const straightToOpus = args.hard === true && Boolean(opusAvailable());
      const job = startJob(String(args.task), folder, hands, {straightToOpus});

      return (
        `Started. Job ${job.id}, working in ${folder}, ` +
        `${straightToOpus ? 'straight to the strongest model' : 'beginning with the cheaper model and stepping up if it needs to'}. ` +
        `It takes minutes, not seconds — tell the user it is running and what ` +
        `it is doing, then get on with the conversation. Check on it with ` +
        `check_code when they ask, or when enough time has passed that they ` +
        `would expect news.`
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
        const now = wanted.attempts.length > 0 ? ' It is on its second attempt.' : '';
        return (
          `Job ${wanted.id} is still going, ${howLong(wanted.startedAt)} in.${now} ` +
          `It is working on: ${wanted.task}`
        );
      }

      /*
       * The whole climb, not just where it ended up.
       *
       * A job that was handed over reads as one thing to her and quite another
       * to the person paying for it: they should know the cheap model tried,
       * why it stopped, and what the expensive one cost. Hiding the ladder
       * would make the bill arrive without an explanation.
       */
      const story = wanted.attempts
        .map((attempt) => {
          const cost = attempt.cost ? `, $${attempt.cost.toFixed(2)}` : '';
          const what = attempt.handedOver
            ? 'handed it on'
            : attempt.ok
              ? 'finished it'
              : 'failed';
          return `${attempt.by} ${what} after ${attempt.seconds}s${cost}: ${attempt.summary}`;
        })
        .join('\n\n');

      const spent = wanted.attempts.reduce((sum, one) => sum + (one.cost ?? 0), 0);

      return (
        `Job ${wanted.id} ${wanted.ok ? 'is done' : 'did not work out'}, in ` +
        `${wanted.folder}${spent > 0 ? ` — $${spent.toFixed(2)} on the card` : ''}.\n\n` +
        `${story}\n\n` +
        `${
          wanted.ok
            ? 'The files are changed on disk. If the user wants it built or tested, that is a separate thing you run yourself.'
            : 'Some files may have been changed before it stopped, so do not tell them the folder is untouched.'
        }`
      );
    },
  },
];
