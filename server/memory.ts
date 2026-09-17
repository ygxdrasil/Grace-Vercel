import {randomUUID} from 'node:crypto';
import type {
  InputMode,
  Message,
  Profile,
  ProfileEntry,
  Speaker,
} from '../shared/types';
import {config} from './config';
import {getProvider} from './llm/index';
import type {Turn} from './llm/types';
import {Document} from './store/index';
import {currentChat, logKey, metaKey} from './chats';

interface Meta {
  /** Prose recap of everything folded out of the verbatim window. */
  summary: string | null;
  /** How many messages from the start of the log the summary already covers. */
  summarizedThrough: number;
}

/**
 * The log and the summary, for whichever conversation is open.
 *
 * Built per call rather than held as module state, because which conversation
 * is current is answered by the store and a serverless instance may handle two
 * requests from two different threads. A Document is a key and two functions;
 * making one costs nothing, and caching it would be caching the wrong answer.
 */
async function logOf(): Promise<Document<Message[]>> {
  return new Document<Message[]>(logKey(await currentChat()), () => []);
}

async function metaOf(): Promise<Document<Meta>> {
  return new Document<Meta>(metaKey(await currentChat()), () => ({
    summary: null,
    summarizedThrough: 0,
  }));
}

const profile = new Document<Profile>('profile', () => ({
  addressAs: null,
  entries: [],
  updatedAt: new Date().toISOString(),
}));



export async function getMessages(): Promise<Message[]> {
  return (await logOf()).read();
}

/**
 * The last thing the user said, and when.
 *
 * Exists for one reason: deciding whether an action she was told to ask about
 * has actually been agreed to. That decision must rest on something the model
 * cannot write — and the model cannot put words in the user's mouth here,
 * because user turns are recorded by the server from what actually arrived.
 */
export async function lastUserSaid(): Promise<{text: string; at: string} | null> {
  const log = await (await logOf()).read();
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const message = log[i];
    if (message?.speaker === 'user') return {text: message.text, at: message.at};
  }
  return null;
}

export function getProfile(): Promise<Profile> {
  return profile.read();
}

export async function getSummary(): Promise<string | null> {
  return (await (await metaOf()).read()).summary;
}

/** How much of the log the summary already covers. Exposed for verification. */
export async function getSummarizedThrough(): Promise<number> {
  return (await (await metaOf()).read()).summarizedThrough;
}

export async function record(
  speaker: Speaker,
  text: string,
  via: InputMode,
): Promise<Message> {
  const message: Message = {
    id: randomUUID(),
    speaker,
    text,
    at: new Date().toISOString(),
    via,
  };
  await (await logOf()).update((log) => [...log, message]);
  return message;
}

/**
 * The window replayed to the model verbatim. Everything older lives in the
 * summary, and the stored log keeps all of it either way.
 *
 * It starts where the summary stops rather than at a fixed depth: compaction
 * runs less often than the window slides, so a fixed depth would drop the
 * messages in between out of context entirely — recent enough to be missing
 * from the summary, old enough to have fallen off the window.
 */
export async function recentTurns(): Promise<Turn[]> {
  const log = await (await logOf()).read();
  const {summarizedThrough} = await (await metaOf()).read();
  const from = Math.min(
    summarizedThrough,
    Math.max(0, log.length - config.verbatimTurns),
  );

  return log.slice(from).map((message) => ({
    role: message.speaker === 'grace' ? ('assistant' as const) : ('user' as const),
    // One enormous message would otherwise ride along verbatim on every turn
    // for the life of the window — thirty-odd re-sends of the same wall of
    // text. The full version stays in the log and search_memory can reach it.
    text:
      message.text.length > 1600
        ? `${message.text.slice(0, 1600)} […cut for length; search_memory has the rest]`
        : message.text,
  }));
}

export function setAddressAs(addressAs: string | null): Promise<Profile> {
  return profile.update((current) => ({
    ...current,
    addressAs,
    updatedAt: new Date().toISOString(),
  }));
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

export async function remember(
  entries: Omit<ProfileEntry, 'id' | 'learnedAt'>[],
): Promise<ProfileEntry[]> {
  if (entries.length === 0) return [];

  const current = await profile.read();
  const now = new Date().toISOString();
  const byKey = new Map(current.entries.map((entry) => [normalise(entry.text), entry]));
  const added: ProfileEntry[] = [];
  let reinforced = false;

  for (const entry of entries) {
    const key = normalise(entry.text);
    if (!key) continue;

    const known = byKey.get(key);
    if (known) {
      // Seen again. Something observed twenty times is not as tentative as
      // something observed once, and she should be able to tell them apart.
      // Hearing it said outright also promotes a guess to a known fact.
      byKey.set(key, {
        ...known,
        timesSeen: (known.timesSeen ?? 1) + 1,
        lastSeenAt: now,
        source: entry.source === 'stated' ? 'stated' : known.source,
        supersededAt: undefined,
      });
      reinforced = true;
      continue;
    }

    const fresh: ProfileEntry = {
      ...entry,
      id: randomUUID(),
      learnedAt: now,
      lastSeenAt: now,
      timesSeen: 1,
    };
    byKey.set(key, fresh);
    added.push(fresh);
  }

  if (added.length > 0 || reinforced) {
    await profile.write({
      ...current,
      entries: [...byKey.values()],
      updatedAt: now,
    });
  }

  return added;
}

/**
 * Mark something as no longer true, without losing it.
 *
 * People change their minds and their circumstances, and an assistant who
 * keeps insisting on last month's version of them is worse than one who
 * forgets. Nothing is deleted: that this used to be true is itself a fact.
 */
export async function supersedeEntry(text: string): Promise<boolean> {
  const key = normalise(text);
  if (!key) return false;

  let found = false;
  await profile.update((current) => ({
    ...current,
    entries: current.entries.map((entry) => {
      if (normalise(entry.text) !== key || entry.supersededAt) return entry;
      found = true;
      return {...entry, supersededAt: new Date().toISOString()};
    }),
    updatedAt: new Date().toISOString(),
  }));
  return found;
}

/** The same fold, demanded rather than triggered. */
export function compactNow(): Promise<boolean> {
  return compactIfNeeded(true);
}

/** What she currently believes — everything not overtaken by something newer. */
export async function currentBeliefs(): Promise<ProfileEntry[]> {
  const {entries} = await profile.read();
  return entries.filter((entry) => !entry.supersededAt);
}

/**
 * How she has learned to deal with this person, as opposed to what she knows
 * about them. Kept short on purpose: a long list of stylistic rules stops
 * being style and starts being noise.
 */
export async function noteStyle(notes: string[]): Promise<void> {
  if (notes.length === 0) return;
  const now = new Date().toISOString();

  await profile.update((current) => {
    const style = [...(current.style ?? [])];

    for (const text of notes) {
      const clean = text.trim();
      if (!clean) continue;
      const at = style.findIndex(
        (note) => normalise(note.text) === normalise(clean),
      );
      if (at >= 0) style[at] = {...style[at], timesSeen: style[at].timesSeen + 1};
      else style.push({id: randomUUID(), text: clean, learnedAt: now, timesSeen: 1});
    }

    // The best-evidenced dozen. Anything beyond that is not a habit she has
    // noticed, it is a list she is accumulating.
    style.sort((left, right) => right.timesSeen - left.timesSeen);
    return {...current, style: style.slice(0, 12), updatedAt: now};
  });
}

export function forget(id: string): Promise<Profile> {
  return profile.update((current) => ({
    ...current,
    entries: current.entries.filter((entry) => entry.id !== id),
    updatedAt: new Date().toISOString(),
  }));
}

export async function clearConversation(): Promise<void> {
  await (await logOf()).write([]);
  await (await metaOf()).write({summary: null, summarizedThrough: 0});
}

/**
 * Folds older turns into the rolling summary once the log outgrows the verbatim
 * window. Runs as its own request so it never sits inside a reply's latency.
 */
export async function compactIfNeeded(force = false): Promise<boolean> {
  const log = await (await logOf()).read();
  const store = await metaOf();
  const current = await store.read();
  const unsummarised = log.length - current.summarizedThrough;

  if (!force && unsummarised <= config.summarizeAfter) return false;

  /*
   * Asked for by hand, she keeps far less back.
   *
   * The automatic pass leaves the last thirty-two turns verbatim, because
   * folding away something said a minute ago makes her look like she was not
   * listening. Someone typing the command has decided the opposite — they want
   * the context small — so only the last few exchanges stay as they were said.
   */
  const keep = force ? 6 : config.verbatimTurns;
  const foldUpTo = log.length - keep;
  const pending = log.slice(current.summarizedThrough, foldUpTo);
  if (pending.length === 0) return false;

  const transcript = pending
    .map(
      (message) =>
        `${message.speaker === 'grace' ? 'Grace' : 'User'}: ${message.text}`,
    )
    .join('\n');

  const system = `You maintain the long-term memory of a personal assistant called Grace.

Rewrite the running summary so it also covers the new exchanges. Keep anything that is still true or still matters: decisions, commitments, ongoing situations, people, plans, and how the user likes things done. Drop small talk and anything already superseded.

Write plain prose, past tense, no more than 300 words. Return only the summary.`;

  const prompt = current.summary
    ? `Running summary so far:\n${current.summary}\n\nNew exchanges:\n${transcript}`
    : `New exchanges:\n${transcript}`;

  try {
    const summary = await getProvider().complete({
      system,
      turns: [{role: 'user', text: prompt}],
      temperature: 0.3,
      maxOutputTokens: 700,
      // Summarising is compression, not reasoning; deliberation tokens here
      // were pure waste billed at the output rate.
      fast: true,
    });

    if (!summary.trim()) return false;
    await store.write({summary: summary.trim(), summarizedThrough: foldUpTo});
    return true;
  } catch (error) {
    // Summarising is a background nicety; failing it must not break the chat.
    console.error('[grace] could not compact memory:', (error as Error).message);
    return false;
  }
}
