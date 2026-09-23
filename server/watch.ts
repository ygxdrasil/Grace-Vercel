import {createHash, randomUUID} from 'node:crypto';
import {Document} from './store/index';

/**
 * "Watch this and tell me when it changes."
 *
 * A price, a stock line, a status page, a release date. She checks each watch
 * on her hourly round and speaks up when it moves — which means the check has
 * to be cheap, because it runs every hour whether or not anything happened.
 * So there is no model call here: she fetches the page, reduces it to text,
 * and compares. If a keyword is given she watches only whether that word is
 * present ("in stock", "sold out", "available"); otherwise she watches the
 * page's text as a whole, hashed, so a change is a changed hash.
 *
 * Watching whole pages is noisy — half the web rewrites a timestamp on every
 * load — so the keyword form is the one to prefer, and she is told as much.
 *
 * Archived, never deleted.
 */

export interface Watch {
  id: string;
  what: string;
  url: string;
  /** A word whose presence is the thing being watched, if any. */
  keyword?: string;
  /** The last observation: the keyword's presence, or a content hash. */
  last?: string;
  lastCheckedAt?: string;
  createdAt: string;
  archivedAt?: string;
}

const store = new Document<Watch[]>('watches', () => []);

export function allWatches(): Promise<Watch[]> {
  return store.read();
}

export async function liveWatches(): Promise<Watch[]> {
  return (await store.read()).filter((watch) => !watch.archivedAt);
}

export async function startWatch(
  what: string,
  url: string,
  keyword?: string,
): Promise<Watch> {
  const clean = what.trim().slice(0, 100);
  const address = url.trim();
  if (!clean || !/^https?:\/\//i.test(address)) {
    throw new Error('a watch needs something to watch and a full https address');
  }

  const watch: Watch = {
    id: randomUUID(),
    what: clean,
    url: address,
    keyword: keyword?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  await store.update((list) => [...list, watch]);
  return watch;
}

export async function stopWatch(what: string): Promise<boolean> {
  const needle = what.toLowerCase().trim();
  let found = false;
  await store.update((list) =>
    list.map((watch) => {
      if (watch.archivedAt || !watch.what.toLowerCase().includes(needle)) return watch;
      found = true;
      return {...watch, archivedAt: new Date().toISOString()};
    }),
  );
  return found;
}

/** Strip a page to comparable text: no tags, no runs of whitespace. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** One reading of a watch, as a short comparable token. */
async function observe(watch: Watch): Promise<string | null> {
  try {
    const response = await fetch(watch.url, {
      headers: {'user-agent': 'Mozilla/5.0 (Grace watch)'},
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const text = textOf(await response.text());

    if (watch.keyword) {
      return text.includes(watch.keyword.toLowerCase()) ? 'present' : 'absent';
    }
    // A hash of the text, so the stored reading stays tiny however big the page.
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export interface WatchChange {
  id: string;
  what: string;
  url: string;
  /** A sentence describing what moved. */
  detail: string;
}

/**
 * Check every watch, returning only the ones that changed.
 *
 * The first reading of a new watch is recorded silently — there is nothing to
 * compare it against yet, and announcing "it is the same as the value I just
 * invented" would be nonsense.
 */
/**
 * How often one watch is fetched, however often she looks around.
 *
 * Mail and the diary are checked every couple of minutes because reading them
 * is free. A watch fetches someone else's whole web page, and doing that every
 * two minutes is rude to the site and pointless for the kind of thing people
 * watch — a restock, a price, a results page.
 */
const WATCH_EVERY_MS = 55 * 60 * 1000;

export async function checkWatches(at = Date.now()): Promise<WatchChange[]> {
  const watches = (await liveWatches()).filter(
    (watch) =>
      !watch.lastCheckedAt || at - new Date(watch.lastCheckedAt).getTime() >= WATCH_EVERY_MS,
  );
  if (watches.length === 0) return [];

  const changes: WatchChange[] = [];
  const now = new Date().toISOString();

  const readings = await Promise.all(
    watches.map(async (watch) => ({watch, reading: await observe(watch)})),
  );

  await store.update((list) =>
    list.map((stored) => {
      const found = readings.find((r) => r.watch.id === stored.id);
      if (!found || found.reading === null) return stored;

      const {reading} = found;
      if (stored.last !== undefined && stored.last !== reading) {
        changes.push({
          id: stored.id,
          what: stored.what,
          url: stored.url,
          detail: stored.keyword
            ? reading === 'present'
              ? `"${stored.keyword}" now appears on the page for ${stored.what}`
              : `"${stored.keyword}" has gone from the page for ${stored.what}`
            : `${stored.what} changed`,
        });
      }

      return {...stored, last: reading, lastCheckedAt: now};
    }),
  );

  return changes;
}
