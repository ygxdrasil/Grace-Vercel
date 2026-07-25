import {randomUUID} from 'node:crypto';
import type {
  InputMode,
  Message,
  Profile,
  ProfileEntry,
  Speaker,
} from '../shared/types.ts';
import {config} from './config.ts';
import {getProvider} from './llm/index.ts';
import type {Turn} from './llm/types.ts';
import {Document} from './store/index.ts';

interface Meta {
  /** Prose recap of everything folded out of the verbatim window. */
  summary: string | null;
  /** How many messages from the start of the log the summary already covers. */
  summarizedThrough: number;
}

const messages = new Document<Message[]>('conversation', () => []);

const profile = new Document<Profile>('profile', () => ({
  addressAs: null,
  entries: [],
  updatedAt: new Date().toISOString(),
}));

const meta = new Document<Meta>('meta', () => ({
  summary: null,
  summarizedThrough: 0,
}));

export function getMessages(): Promise<Message[]> {
  return messages.read();
}

export function getProfile(): Promise<Profile> {
  return profile.read();
}

export async function getSummary(): Promise<string | null> {
  return (await meta.read()).summary;
}

/** How much of the log the summary already covers. Exposed for verification. */
export async function getSummarizedThrough(): Promise<number> {
  return (await meta.read()).summarizedThrough;
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
  await messages.update((log) => [...log, message]);
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
  const log = await messages.read();
  const {summarizedThrough} = await meta.read();
  const from = Math.min(
    summarizedThrough,
    Math.max(0, log.length - config.verbatimTurns),
  );

  return log.slice(from).map((message) => ({
    role: message.speaker === 'grace' ? ('assistant' as const) : ('user' as const),
    text: message.text,
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
  const existing = new Set(current.entries.map((entry) => normalise(entry.text)));
  const added: ProfileEntry[] = [];

  for (const entry of entries) {
    const key = normalise(entry.text);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    added.push({...entry, id: randomUUID(), learnedAt: new Date().toISOString()});
  }

  if (added.length > 0) {
    await profile.write({
      ...current,
      entries: [...current.entries, ...added],
      updatedAt: new Date().toISOString(),
    });
  }

  return added;
}

export function forget(id: string): Promise<Profile> {
  return profile.update((current) => ({
    ...current,
    entries: current.entries.filter((entry) => entry.id !== id),
    updatedAt: new Date().toISOString(),
  }));
}

export async function clearConversation(): Promise<void> {
  await messages.write([]);
  await meta.write({summary: null, summarizedThrough: 0});
}

/**
 * Folds older turns into the rolling summary once the log outgrows the verbatim
 * window. Runs as its own request so it never sits inside a reply's latency.
 */
export async function compactIfNeeded(): Promise<boolean> {
  const log = await messages.read();
  const current = await meta.read();
  const unsummarised = log.length - current.summarizedThrough;

  if (unsummarised <= config.summarizeAfter) return false;

  const foldUpTo = log.length - config.verbatimTurns;
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
    });

    if (!summary.trim()) return false;
    await meta.write({summary: summary.trim(), summarizedThrough: foldUpTo});
    return true;
  } catch (error) {
    // Summarising is a background nicety; failing it must not break the chat.
    console.error('[grace] could not compact memory:', (error as Error).message);
    return false;
  }
}
