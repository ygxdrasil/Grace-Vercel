import {ThinkingLevel} from '@google/genai';
import type {ThinkingConfig} from '@google/genai';
import {THINKING} from '../../shared/effort';

/**
 * How much thought to ask for, in whichever dialect the model speaks.
 *
 * On the 2.5 line deliberation was a number of tokens — `thinkingBudget` —
 * and shared/effort.ts is built around that: it works out, per sentence,
 * roughly how many tokens of reasoning the sentence is worth.
 *
 * The 3.x line replaced that with `thinkingLevel`, four named steps. The two
 * cannot be mixed: a request carrying both is rejected outright with a 400,
 * so this is not a matter of preferring one. It is a fork, and a model that
 * gets the wrong side of it does not degrade gracefully — it fails every
 * call.
 *
 * Rather than rewrite effort.ts in the new vocabulary, the token figures stay
 * as the thing the rest of Grace reasons about, and get translated here at
 * the edge. The reasoning in effort.ts is about how much a sentence deserves,
 * which is a real judgement and survives the change of units. Google's naming
 * is not, and has now changed once.
 */

/** Anything on the 3.x line or later takes levels rather than token budgets. */
function speaksLevels(model: string): boolean {
  const generation = Number(/gemini-(\d+)/.exec(model)?.[1]);
  return Number.isFinite(generation) && generation >= 3;
}

/**
 * Which models will not accept every level.
 *
 * Pro offers only `low` and `high` — there is no middle on it. Asking for
 * `medium` is a 400, which would make every ordinary question routed to Pro
 * fail while the same question on Flash succeeded: a bug that would look like
 * Pro being broken rather than like a two-value enum.
 */
/*
 * `minimal` is never sent. To anything.
 *
 * It exists in the API and it was in the table below for the Flash-Lite line,
 * and 3.8 Flash rejected it outright — "Thinking level is unsupported:
 * THINKING_LEVEL_MINIMAL" — twenty-three times before anyone read the logs.
 * Every request marked `fast` had been failing: her greeting on every open,
 * memory compaction, learning from conversation. Silently, because those are
 * background jobs and their failures are caught and logged rather than shown.
 *
 * Which models accept it is not documented per model and has already changed
 * once. `low` is accepted everywhere on the 3.x line, and the difference in
 * cost between low and minimal on a background job is a few hundred tokens a
 * day. Robust beats thrifty here by a very wide margin.
 */
const LEVELS_ALLOWED: {match: RegExp; levels: Level[]}[] = [
  /*
   * Pro is capped at `low` on purpose, and this is a latency decision rather
   * than a quality one.
   *
   * The hosting kills any request at sixty seconds and returns *nothing* —
   * not a partial answer, not an error anyone can read, just silence. Pro
   * thinking at `high` on a question that also needs three or four tool calls
   * does not fit in that window. So the choice is not "well-reasoned answer
   * versus quick answer". It is "decent answer versus no answer at all", and
   * an empty reply is the worst outcome available.
   *
   * Pro at `low` still reasons considerably better than Flash at `high`,
   * which is the whole reason the hard turns are routed here. The tier is
   * doing the work; the level was only ever going to buy the last few
   * percent, at the price of the entire response.
   *
   * Raise this the day she runs somewhere without a sixty-second guillotine.
   */
  {match: /pro/i, levels: ['low']},
];

/** What a model gets when nothing above names it: everything but `minimal`. */
const USUAL: Level[] = ['low', 'medium', 'high'];

export type Level = 'minimal' | 'low' | 'medium' | 'high';

const ORDER: Level[] = ['minimal', 'low', 'medium', 'high'];

/**
 * Where the token figures land as names.
 *
 * `reflex` deliberately maps to `low` and not to `minimal`. Minimal is
 * near-zero reasoning, and near-zero reasoning with a tool attached is the
 * exact failure this codebase has already paid for once: she keeps the search
 * tool, never decides to call it, and reports that she cannot reach the
 * internet. Deciding to use a tool is itself deliberation. The floor stays
 * above the point where that decision stops happening.
 */
function nameFor(tokens: number): Level {
  if (tokens <= 0) return 'minimal';
  if (tokens <= THINKING.reflex) return 'low';
  if (tokens <= THINKING.ordinary) return 'medium';
  return 'high';
}

/**
 * Nudges a level to the nearest one this model actually offers.
 *
 * Downward first, then upward, so a model with no `medium` gets `low` rather
 * than being silently promoted to `high` and charged for it. Paying more than
 * asked is the worse direction to round in when the whole point of the tier
 * is to make the credits last.
 */
function nearest(level: Level, allowed: Level[]): Level {
  if (allowed.includes(level)) return level;

  const wanted = ORDER.indexOf(level);
  const below = ORDER.filter((l, i) => i < wanted && allowed.includes(l)).pop();
  return below ?? allowed.find((l) => ORDER.indexOf(l) > wanted) ?? allowed[0]!;
}

export function levelsFor(model: string): Level[] {
  return LEVELS_ALLOWED.find((entry) => entry.match.test(model))?.levels ?? USUAL;
}

/**
 * Exported separately so the self-test can check the mapping without
 * constructing a provider or reaching the network.
 */
export function levelFor(model: string, tokens: number): Level {
  return nearest(nameFor(tokens), levelsFor(model));
}

/**
 * The SDK spells these in capitals and Grace spells them in lower case.
 *
 * Kept as a table rather than an `.toUpperCase()` so that a level the SDK
 * stops offering fails to compile here, in this file, rather than at runtime
 * inside a request — which is how the last naming change announced itself.
 */
const AS_SDK: Record<Level, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export function thinkingFor(model: string, tokens: number): ThinkingConfig {
  return speaksLevels(model)
    ? {thinkingLevel: AS_SDK[levelFor(model, tokens)]}
    : {thinkingBudget: tokens};
}
