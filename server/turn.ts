import {type Deliberation, effortFor} from '../shared/effort';
import type {Choice, InputMode, Message} from '../shared/types';
import {getPolicies} from './actions';
import {available} from './available';
import {currentChat, titleFrom, touch} from './chats';
import {config, isConfigured} from './config';
import {buildBriefing} from './google/briefing';
import {getProvider} from './llm/index';
import {getMode} from './modes';
import {getProfile, getSummary, record, recentTurns} from './memory';
import {buildSystemPrompt} from './persona';
import {styleNote} from './style';
import {onAsk} from './tools/ask';
import {declarations, runTool} from './tools/index';
import {onOpen} from './tools/open';

/**
 * One turn of Grace, with nothing about a browser in it.
 *
 * This used to live inside the /chat route, wound through the code that writes
 * server-sent events. That was fine while a browser was the only thing that
 * could talk to her — and stopped being fine the moment anything else wanted
 * to, because the alternative was a second copy of the pipeline that would
 * drift from this one and quietly become a different assistant. The prompt,
 * the tools, the memory, the guardrails and the budget are assembled in
 * exactly one place, and every caller gets that same Grace.
 *
 * What varies is only how the turn is *watched*: the browser wants each word
 * the instant it exists, a voice assistant relaying her through a phone wants
 * the finished sentence and nothing else. That is the hooks argument, and it
 * is the whole difference.
 */

export interface TurnHooks {
  /** A fragment of the reply, as it is generated. */
  onDelta?(text: string): void;
  onSearched?(): void;
  onSearchFailed?(reason: string): void;
  onActed?(name: string, summary: string): void;
  onAsked?(question: string, choices: Choice[]): void;
  onOpened?(urls: string[], workspace?: string): void;
}

export interface TurnResult {
  /** What she said. Possibly partial, if it failed part way through. */
  reply: string;
  /** The recorded message, or null if there was nothing worth recording. */
  message: Message | null;
  /** Set when something went wrong, phrased for the person waiting. */
  error: string | null;
  /** Every tool she used, in order, as the user would be told about it. */
  acted: {name: string; summary: string}[];
  /** How hard she was allowed to think, and why. */
  deliberation: Deliberation;
}

/**
 * How long she may go on starting new actions before she has to answer.
 *
 * The hosting cuts the request off at sixty seconds and returns nothing —
 * not a timeout message, nothing — so this is the point at which she stops
 * reaching for anything else and writes up what she has. Fifteen seconds of
 * headroom is enough for a long reply to stream out and be recorded even if
 * the last tool ran right up to the line.
 */
const TOOLS_UNTIL_MS = 45_000;

export const NO_KEY_MESSAGE =
  'No Gemini API key is configured, so I have no voice to think with. ' +
  'Add GEMINI_API_KEY and restart me.';

export interface TurnRequest {
  text: string;
  via: InputMode;
  signal?: AbortSignal;
  hooks?: TurnHooks;
}

/**
 * Who she is, right now, and what she can reach.
 *
 * Everything the prompt needs, gathered at once. Pulled out of takeTurn so
 * that the voice — which runs on another machine and holds its own model
 * session — is briefed from exactly the same place. Before this the outpost
 * opened its session with no system prompt and no tools at all: a nameless
 * model with no hands, wearing her voice. The typed Grace and the spoken one
 * must be one person, and one person has one briefing.
 */
export async function briefFor(via: InputMode): Promise<{
  system: string;
  have: Awaited<ReturnType<typeof available>>;
  turns: Awaited<ReturnType<typeof recentTurns>>;
  tools: ReturnType<typeof declarations>;
}> {
  const [profile, summary, policies, turns, have, attention, briefing, style] =
    await Promise.all([
      getProfile(),
      getSummary(),
      getPolicies(),
      recentTurns(),
      available(),
      getMode(),
      buildBriefing().catch(() => null),
      styleNote().catch(() => null),
    ]);

  const system = buildSystemPrompt({
    available: have,
    profile,
    summary,
    policies,
    via,
    now: new Date(),
    mode: attention.mode,
    briefing,
    style,
  });

  return {system, have, turns, tools: declarations(have)};
}

export async function takeTurn({
  text,
  via,
  signal,
  hooks = {},
}: TurnRequest): Promise<TurnResult> {
  const acted: {name: string; summary: string}[] = [];
  const deliberation = effortFor(text);
  const startedAt = Date.now();

  if (!isConfigured()) {
    return {reply: '', message: null, error: NO_KEY_MESSAGE, acted, deliberation};
  }

  /*
   * Everything the prompt needs, at once, and that word is load-bearing.
   *
   * Five of these used to be awaited one after another — what is connected,
   * the attention mode, the briefing, the writing style. Each is at least one
   * round trip to the store, and the briefing is two more to Google on a cold
   * instance, so they added up to something close to two seconds of silence
   * before the model had even been asked the question. None of them depends on
   * any other. Waiting for them in sequence bought nothing at all; the cost was
   * simply the sum rather than the slowest.
   */
  const [, , {system, have, turns}] = await Promise.all([
    record('user', text, via),
    // The conversation is named after the first thing said in it, and moves
    // to the top of the list every time it is used.
    currentChat().then(async (id) => {
      await titleFrom(id, text);
      await touch(id);
    }),
    briefFor(via),
  ]);

  // The turn just recorded is not in `turns`, which was read alongside it.
  turns.push({role: 'user', text});

  let reply = '';
  let grounded = false;
  /** Tool name to the one line the user should see about it. */
  const shown = new Map<string, string>();

  // A question she asks goes out the instant she asks it, rather than waiting
  // for the reply to finish — the buttons and the sentence that introduces
  // them should appear together.
  onAsk((question, choices) => hooks.onAsked?.(question, choices));
  // Likewise for pages: the browser is the only thing that can open a tab, so
  // the instruction travels alongside the words.
  onOpen((urls, workspace) => hooks.onOpened?.(urls, workspace));

  try {
    for await (const delta of getProvider().stream({
      system,
      turns,
      ...(signal ? {signal} : {}),
      // How hard to think about this particular sentence, rather than one
      // figure for everything anyone ever says to her. A light switch gets a
      // glance; a question about why something happened gets sixteen times
      // the deliberation, which is the difference between her first thought
      // and her considered one.
      think: deliberation.think,
      temperature: deliberation.temperature,
      /*
       * The handful of turns a day worth paying Pro rates for.
       *
       * Deliberation used to be the only dial, which bought more of the same
       * reasoning rather than better reasoning — a hard question got a longer
       * run at the same thinking. This is the other half: the turns already
       * judged `hard` go to the better model as well as getting more room.
       *
       * Left undefined otherwise, so every command and every ordinary
       * exchange stays on Flash. That ratio is what makes the credit last
       * ninety days rather than nine; Pro on everything would cost roughly
       * three times as much for no gain on "turn the lights off".
       */
      ...(deliberation.effort === 'hard' ? {model: config.hardModel} : {}),
      // Enough left to write the answer, speak it, and record it after the
      // last tool comes back. The hosting stops the whole request dead at
      // sixty seconds and returns nothing — no reply and no reason — so the
      // margin is deliberately generous. An answer about three of four things
      // beats silence about all four.
      deadline: startedAt + TOOLS_UNTIL_MS,
      // Room for the reply. Deliberation is added on top of this by the
      // provider — on Gemini the two share one ceiling, and a caller who does
      // not know that raises the thinking budget and gets back an empty string.
      maxOutputTokens: 2048,
      onGrounded: () => {
        if (!grounded) {
          grounded = true;
          hooks.onSearched?.();
        }
      },
      onSearchFailed: (reason) => hooks.onSearchFailed?.(reason),
      // Only what is connected. Held for minutes at a time so the list stays
      // byte-identical between messages and keeps the cache discount.
      tools: declarations(have),
      // What the model reads and what the user sees are different strings, and
      // only this layer holds both. The provider hands onToolUsed whatever
      // onToolCall returned — the raw result — so checking the mail put the
      // entire inbox on screen no matter how carefully the tool layer worded
      // its summary. It is kept here instead.
      onToolCall: async (name, args) => {
        const outcome = await runTool({name, args});
        shown.set(name, outcome.summary);
        return outcome.result;
      },
      onToolUsed: (name, raw) => {
        const summary = shown.get(name) ?? raw;
        // Searching is an action like any other, but reads better as "checked
        // the web" than as a line of results.
        if (name === 'search_web') {
          if (!grounded) {
            grounded = true;
            hooks.onSearched?.();
          }
          return;
        }
        acted.push({name, summary});
        hooks.onActed?.(name, summary);
      },
    })) {
      reply += delta;
      hooks.onDelta?.(delta);
    }
  } catch (error) {
    const detail = (error as Error).message ?? 'unknown error';
    console.error('[grace] generation failed:', detail);

    // A half-finished reply is still worth keeping; the user heard it.
    const message = reply.trim() ? await record('grace', reply, via) : null;
    return {
      reply,
      message,
      error: `I couldn't finish that thought — ${detail}`,
      acted,
      deliberation,
    };
  }

  if (!reply.trim()) {
    return {
      reply: '',
      message: null,
      error: 'I drew a blank there. Try me again.',
      acted,
      deliberation,
    };
  }

  return {
    reply,
    message: await record('grace', reply, via),
    error: null,
    acted,
    deliberation,
  };
}
