import {getProvider} from '../llm/index';
import {config} from '../config';
import type {Attempt} from './types';

/**
 * The first attempt at a coding job, made with the model she already pays for.
 *
 * Most programming asked of an assistant is small: a script that renames
 * files, a function that was nearly right, a config nobody can remember the
 * shape of. Sending all of that to Opus is paying the fee for the hardest
 * thing she might ever be asked in order to do the easiest. This tries it with
 * Gemini Pro first — which comes out of the promotional credit rather than the
 * card — and the ladder above escalates when it does not work out.
 *
 * It is a real agent loop rather than one shot at a file: it looks, reads,
 * writes, and looks again. What it may do is exactly what Claude Code is given
 * in `acceptEdits` — read and write within the folder, and no shell. The two
 * rungs of the ladder having the same reach is the point. A fallback that can
 * do *more* than the thing it falls back from is not a fallback, it is a
 * second, differently-shaped hole in the same fence.
 */

/** Rounds of looking and editing before it has to stop and say where it got to. */
const MOST_ROUNDS = 28;

const TOOLS = [
  {
    name: 'look',
    description: 'List what is in a folder.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {path: {type: 'STRING', description: 'The folder'}},
      required: ['path'],
    },
  },
  {
    name: 'read',
    description: 'Read a text file. Read before you change anything.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {path: {type: 'STRING', description: 'The file'}},
      required: ['path'],
    },
  },
  {
    name: 'write',
    description:
      'Write a file, whole. There is no patching — give the entire contents ' +
      'every time, including the parts you are not changing.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        path: {type: 'STRING', description: 'The file'},
        text: {type: 'STRING', description: 'The complete contents'},
      },
      required: ['path', 'text'],
    },
  },
  {
    /*
     * An honest way out, which is the whole reason the ladder works.
     *
     * Without this the only signal that it is out of its depth is the shape of
     * its final paragraph, and a model asked whether it succeeded will usually
     * say yes. A tool call is a fact. Described so that using it is the
     * obviously correct move rather than an admission — a model that thinks
     * giving up is failure will keep going and produce something worse.
     */
    name: 'hand_over',
    description:
      'Stop, and hand the job to a stronger model. The right move the moment ' +
      'this is bigger or subtler than you can do well — it costs nothing but ' +
      'a moment, and a half-finished change is far worse than an untouched ' +
      'folder. Say plainly what you learned and where you got stuck.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        why: {type: 'STRING', description: 'What defeated it, and what you found out'},
      },
      required: ['why'],
    },
  },
];

const HOW_TO_WORK = `You are editing code in a folder on someone's computer.

Work like this: look at the folder, read the files you are about to change
before you change them, then write them. You get the whole file back and you
give the whole file back — there is no patching, so never write a fragment or
a file with "... rest unchanged ..." in it. That has destroyed real work.

You cannot run anything. No builds, no tests, no shell. Write code you are
confident in by reading enough first, because you will not get to see it run.

If the job turns out to be bigger or subtler than you can do well, call
hand_over immediately and say what you found. A stronger model takes over from
there and your notes are the most useful thing you can give it. Handing over
early is the right call and costs almost nothing. Half-finishing something is
the one genuinely bad outcome here.

When you are done, say in two or three sentences what you changed and why.`;

export async function runWithGemini(
  task: string,
  folder: string,
  hands: (action: string, path: string, body?: string) => Promise<string>,
): Promise<Attempt> {
  const began = Date.now();
  let handedOver: string | null = null;
  let edited = 0;
  let rounds = 0;

  try {
    const said = await getProvider().complete({
      system: HOW_TO_WORK,
      turns: [{role: 'user', text: `The folder is ${folder}.\n\nThe job:\n\n${task}`}],
      // Her hard model: the good one she already has credit for.
      model: config.hardModel,
      temperature: 0.2,
      maxOutputTokens: 4096,
      tools: TOOLS,
      onToolCall: async (name, args) => {
        rounds += 1;
        if (rounds > MOST_ROUNDS) {
          handedOver ??= `ran out of room after ${MOST_ROUNDS} steps`;
          return 'Stop now and say where you got to.';
        }

        if (name === 'hand_over') {
          handedOver = String(args.why ?? 'no reason given');
          return 'Understood. Stop there.';
        }

        const path = String(args.path ?? '');
        if (name === 'look') return hands('ls', path);
        if (name === 'read') return hands('read', path);
        if (name === 'write') {
          edited += 1;
          return hands('write', path, String(args.text ?? ''));
        }
        return `There is no tool called ${name}.`;
      },
    });

    if (handedOver) {
      return {
        by: 'gemini-3.1-pro',
        ok: false,
        handedOver: true,
        summary: handedOver,
        seconds: Math.round((Date.now() - began) / 1000),
        edited,
      };
    }

    /*
     * Finished without touching anything.
     *
     * Read as a failure rather than a success, and deliberately. A coding job
     * that changed no files did not do the job — the likeliest explanations
     * are that it could not find what it was looking for or talked itself out
     * of the work, and both are exactly what the next rung is for. The cost of
     * being wrong here is one Opus run on something already done; the cost of
     * the other mistake is telling someone their code is written when it is not.
     */
    if (edited === 0) {
      return {
        by: 'gemini-3.1-pro',
        ok: false,
        handedOver: true,
        summary: `finished without changing any files. It said: ${said.trim()}`,
        seconds: Math.round((Date.now() - began) / 1000),
        edited,
      };
    }

    return {
      by: 'gemini-3.1-pro',
      ok: true,
      handedOver: false,
      summary: said.trim() || `Changed ${edited} file${edited === 1 ? '' : 's'}.`,
      seconds: Math.round((Date.now() - began) / 1000),
      edited,
    };
  } catch (error) {
    return {
      by: 'gemini-3.1-pro',
      ok: false,
      handedOver: true,
      summary: `it fell over: ${(error as Error).message}`,
      seconds: Math.round((Date.now() - began) / 1000),
      edited,
    };
  }
}
