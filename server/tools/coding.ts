import {jobById, opusAvailable, recentJobs, startJob, useShell} from '../coding/index';
import {requireBudget} from '../budget';
import {findSuite, runSuite} from '../coding/tests';
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

      /*
       * Running the tests, which is the ladder's job and not the model's.
       *
       * The coding models still get no shell. This is her, between attempts,
       * running one of a fixed list of literal commands chosen by which files
       * exist — never a string read out of one. Handed in rather than held by
       * the ladder, so everything she does on that machine still goes through
       * the same single implementation of the boundary.
       */
      useShell(async (where, command) => {
        const done = await carryOut('shell', command, {body: where});
        return {ok: done.ok, detail: done.detail};
      });

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
    name: 'ask_opus',
    description:
      'Ask the strongest model a question about code, and get an answer back ' +
      'rather than a change. For "how should I approach this", "why is this ' +
      'behaving like that", or a second opinion before something is built. It ' +
      'can read the folder but cannot change anything. Use write_code when ' +
      'the answer is meant to end up in the files.',
    parameters: {
      question: {
        type: 'string',
        description:
          'The whole question, with the context it needs. It cannot see this ' +
          'conversation — only the question and the folder.',
      },
      folder: {
        type: 'string',
        description: 'The project it should read while thinking about it.',
      },
    },
    required: ['question', 'folder'],
    category: 'machine',
    run: async (args) => {
      if (config.deployed) return NOT_LOCAL;
      if (!opusAvailable()) {
        return (
          'Claude Code is not installed on this machine, so there is nothing ' +
          'to ask. Tell the user to install it — `npm install -g ' +
          '@anthropic-ai/claude-code`, then `claude` once to sign in — and do ' +
          'not answer as though you had asked.'
        );
      }

      try {
        await requireBudget();
      } catch (stopped) {
        return `${(stopped as Error).message} Asking costs money too. Say so plainly.`;
      }

      const folder = String(args.folder);
      const {runTool} = await import('./index');
      const looked = await runTool({name: 'list_folder', args: {path: folder}});
      if (!looked.ok || /outside the folders/.test(looked.result)) {
        return `I cannot look there. ${looked.result}`;
      }

      const {askOpus} = await import('../coding/consult');
      const answer = await askOpus(String(args.question), folder);

      if (answer.cost) {
        // Anthropic's bill, like the coding rung above it.
        const {recordOutside} = await import('../budget');
        void recordOutside('claude-opus-5 (asking)', answer.cost).catch(() => {});
      }

      if (!answer.ok) return `That did not work: ${answer.text}`;

      return (
        `Opus says, after ${answer.seconds} seconds` +
        `${answer.cost ? ` and $${answer.cost.toFixed(2)}` : ''}:\n\n${answer.text}\n\n` +
        `Nothing was changed — this was a question, not a job. Tell the user ` +
        `what it said in your own words, and offer to act on it if that is ` +
        `what they want.`
      );
    },
  },
  {
    name: 'improve_yourself',
    description:
      'Work on your own source code. Use this when the user asks you to fix, ' +
      'change or add something to yourself. It makes a git branch first, does ' +
      'the work there, and runs your own test suite — nothing touches the ' +
      'branch they are on and nothing is committed. Describe the change as ' +
      'fully as you would to somebody who cannot see this conversation.',
    parameters: {
      task: {
        type: 'string',
        description:
          'The change, in plain words: what is wrong or missing, what it ' +
          'should do instead, and how anyone would know it worked.',
      },
      hard: {
        type: 'boolean',
        description: 'True for a large or subtle change, to skip the cheaper first attempt.',
      },
    },
    required: ['task'],
    category: 'machine',
    run: async (args) => {
      if (config.deployed) return NOT_LOCAL;

      try {
        await requireBudget();
      } catch (stopped) {
        return `${(stopped as Error).message} Say so plainly.`;
      }

      const {carryOut} = await import('../../bridge/bridge.mjs');
      const run = async (command: string, folder: string) => {
        const done = await carryOut('shell', command, {body: folder});
        return {ok: done.ok, detail: done.detail};
      };

      /*
       * The rails, before anything exists to undo.
       *
       * A dirty working tree stops this outright: uncommitted work belongs to
       * whoever left it there, and a coding agent let loose on top of it would
       * bury changes nobody has a copy of.
       */
      const {prepare} = await import('../coding/self');
      const ready = await prepare(String(args.task), run);
      if (!ready.ok || !ready.repo) return ready.why ?? 'I could not get ready to do that.';

      const hands = async (action: string, path: string, body?: string) => {
        const done = await carryOut(action, path, {body, replace: true});
        return done.detail;
      };
      useShell(async (where, command) => run(command, where));

      const job = startJob(String(args.task), ready.repo.root, hands, {
        straightToOpus: args.hard === true && Boolean(opusAvailable()),
      });
      job.branch = ready.repo.branch;

      return (
        `Started, on a new branch: ${ready.repo.branch}. I am working on my ` +
        `own source, so nothing changes about the me they are talking to now — ` +
        `a restart is what would pick it up. Tell them the branch name and that ` +
        `it will take minutes, then carry on. Check with check_code.`
      );
    },
  },
  {
    name: 'look_at_screen',
    description:
      'Take one picture of the user’s screen and answer a question about it. ' +
      'For "what does this error say", "why does this look wrong", or reading ' +
      'something they are pointing at. One frame, not a stream. Say you are ' +
      'looking before you do it — nobody likes finding out afterwards.',
    parameters: {
      question: {
        type: 'string',
        description: 'What to look for, or what the user wants to know about it.',
      },
    },
    required: ['question'],
    category: 'machine',
    run: async (args) => {
      if (config.deployed) return NOT_LOCAL;
      if (!opusAvailable()) {
        return (
          'I can photograph the screen but nothing here can read the picture — ' +
          'Claude Code is not installed. Tell the user to install it: ' +
          '`npm install -g @anthropic-ai/claude-code`, then `claude` to sign in.'
        );
      }

      try {
        await requireBudget();
      } catch (stopped) {
        return `${(stopped as Error).message} Say so plainly.`;
      }

      const {carryOut} = await import('../../bridge/bridge.mjs');
      const run = async (command: string, folder: string) => {
        const done = await carryOut('shell', command, {body: folder});
        return {ok: done.ok, detail: done.detail};
      };

      const {captureScreen, screensFolder} = await import('../coding/screen');
      const shot = await captureScreen(run);
      if (!shot.ok || !shot.path) return `I could not look: ${shot.why}`;

      /*
       * The picture is read where it lies, by the model that can see.
       *
       * Handed the path rather than the pixels: Claude Code reads image files
       * itself, so nothing has to be encoded, carried through a conversation,
       * or held in memory here. It is given only the tools that look, so it
       * cannot act on what it sees — this answers a question and nothing more.
       */
      const {askOpus} = await import('../coding/consult');
      const answer = await askOpus(
        `Look at the screenshot at ${shot.path} — it is a picture of the ` +
          `user's screen, taken just now. Answer this about it, plainly and ` +
          `without preamble:\n\n${String(args.question)}`,
        screensFolder(),
      );

      if (answer.cost) {
        const {recordOutside} = await import('../budget');
        void recordOutside('claude-opus-5 (looking)', answer.cost).catch(() => {});
      }

      if (!answer.ok) return `I took the picture but could not read it: ${answer.text}`;

      return (
        `${answer.text}\n\n` +
        `That was one frame of their whole screen, and it left this machine to ` +
        `be read. If they did not expect that, say so. The picture is deleted ` +
        `within the half hour.`
      );
    },
  },
  {
    name: 'run_tests',
    description:
      'Run a project’s own test suite and report what it said. Works out ' +
      'which suite it is from what is in the folder. Use it after a coding ' +
      'job when the user asks whether it works, or on its own to find out ' +
      'whether something is currently broken.',
    parameters: {
      folder: {type: 'string', description: 'The project folder'},
    },
    required: ['folder'],
    category: 'machine',
    run: async (args) => {
      if (config.deployed) return NOT_LOCAL;

      const folder = String(args.folder);
      const {carryOut} = await import('../../bridge/bridge.mjs');
      const hands = async (action: string, path: string, body?: string) =>
        (await carryOut(action, path, {body})).detail;

      const listing = await hands('ls', folder);
      if (/outside the folders/.test(listing)) return `I cannot look there. ${listing}`;

      const command = await findSuite(folder, hands);
      if (!command) {
        return (
          `There is no test suite in ${folder} that I recognise — no ` +
          `package.json, Cargo.toml, go.mod, pyproject.toml or Makefile. Say ` +
          `so plainly: nothing has checked this code.`
        );
      }

      const run = await runSuite(folder, command, async (cmd, where) => {
        const done = await carryOut('shell', cmd, {body: where});
        return {ok: done.ok, detail: done.detail};
      });

      return run.passed
        ? `\`${run.command}\` passed, in ${run.seconds} seconds.\n\n${run.output}`
        : `\`${run.command}\` failed after ${run.seconds} seconds:\n\n${run.output}`;
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

      /*
       * The tests, and the difference between three outcomes that must never
       * be allowed to look alike.
       *
       * Passed is a fact worth stating. Failed is the whole answer. And a
       * folder with no suite at all has earned no confidence whatsoever — code
       * that has not been run is a draft, and reporting that as done, with no
       * mention that nothing checked it, is the single most misleading thing
       * this tool could say.
       */
      const last = wanted.tested[wanted.tested.length - 1];
      const verdict = wanted.noSuite
        ? 'There are no tests in that folder, so nothing has checked this. Say that ' +
          'plainly — it is written but unproven, and the user should know before ' +
          'they rely on it.'
        : last?.passed
          ? `Then \`${last.command}\` passed.`
          : last
            ? `\`${last.command}\` is still failing:\n\n${last.output}`
            : 'The tests were never reached.';

      /*
       * Where the work is, when the work is on her.
       *
       * A change to her own source that is reported without naming the branch
       * is a change nobody can find, review or throw away — and since she does
       * not commit or merge, the branch name is the only handle on it that
       * exists.
       */
      let onHer = '';
      if (wanted.branch) {
        const {carryOut} = await import('../../bridge/bridge.mjs');
        const {summarise} = await import('../coding/self');
        onHer = `\n\n${await summarise(
          {root: wanted.folder, branch: wanted.branch},
          async (command, folder) => {
            const done = await carryOut('shell', command, {body: folder});
            return {ok: done.ok, detail: done.detail};
          },
        )}\n\nThis is my own source, so the me they are speaking to has not ` +
          `changed. A restart is what would pick it up.`;
      }

      return (
        `Job ${wanted.id} ${wanted.ok ? 'is done' : 'did not work out'}, in ` +
        `${wanted.folder}${spent > 0 ? ` — $${spent.toFixed(2)} on the card` : ''}.\n\n` +
        `${story}\n\n${verdict}${onHer}\n\n` +
        `${
          wanted.ok
            ? 'The files are changed on disk.'
            : 'Some files may have been changed before it stopped, so do not tell them the folder is untouched.'
        }`
      );
    },
  },
];
