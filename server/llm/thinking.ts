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
const LEVELS_ALLOWED: {match: RegExp; levels: Level[]}[] = [
  {match: /pro/i, levels: ['low', 'high']},
  {match: /lite/i, levels: ['minimal', 'low', 'medium', 'high']},
];

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
  return LEVELS_ALLOWED.find((entry) => entry.match.test(model))?.levels ?? ORDER;
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
