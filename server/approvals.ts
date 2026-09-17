import {randomUUID} from 'node:crypto';
import {Document} from './store/index';

/**
 * Actions she has been told to ask about, waiting for a yes.
 *
 * The gate in tools/index refuses anything in an "always ask" category. Until
 * now that was the whole mechanism: refuse, tell the model to ask, and then —
 * nothing. The user said yes, the model called the tool again, the gate
 * refused it again. Sending and spending were not gated, they were
 * impossible, and the only reason nobody noticed is that no tool in those
 * categories existed yet. The web agent is about to add several.
 *
 * So a refusal now leaves a receipt: exactly what was about to be done, with
 * exactly which arguments, held for a few minutes under an id. Confirming
 * runs *that* — not whatever the model would like to run next, which is the
 * difference between "you agreed to this email" and "you agreed to an email".
 */

export interface Pending {
  id: string;
  name: string;
  args: Record<string, unknown>;
  at: string;
}

/** Long enough to read what she is proposing and answer. Short enough that a
 * yes said tomorrow about something else cannot be taken as consent. */
const HOLD_FOR_MS = 5 * 60 * 1000;

const store = new Document<Pending[]>('approvals', () => []);

function live(all: Pending[], now = Date.now()): Pending[] {
  return all.filter((entry) => now - new Date(entry.at).getTime() < HOLD_FOR_MS);
}

export async function hold(name: string, args: Record<string, unknown>): Promise<Pending> {
  const entry: Pending = {id: randomUUID().slice(0, 8), name, args, at: new Date().toISOString()};
  await store.update((all) => [...live(all), entry]);
  return entry;
}

/** Removes and returns it, so one yes can only ever run it once. */
export async function take(id: string): Promise<Pending | null> {
  let found: Pending | null = null;
  await store.update((all) => {
    const current = live(all);
    found = current.find((entry) => entry.id === id) ?? null;
    return current.filter((entry) => entry.id !== id);
  });
  return found;
}

/**
 * Puts one back, unchanged.
 *
 * A confirm that arrives before the yes has been said must not lose the
 * receipt — and must not re-hold it under a fresh id either, because the
 * model is still holding the old one and would be told "nothing is held
 * under that" the moment the user actually agrees.
 */
export async function restore(entry: Pending): Promise<void> {
  await store.update((all) => [...live(all).filter((e) => e.id !== entry.id), entry]);
}

export async function pending(): Promise<Pending[]> {
  return live(await store.read());
}
