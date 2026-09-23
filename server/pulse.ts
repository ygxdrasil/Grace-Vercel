import type {AttentionMode, Message} from '../shared/types';
import {record} from './memory';
import {upcoming} from './google/calendar';
import {recentMail} from './google/gmail';
import {connection} from './google/oauth';
import {noteDeed} from './journal';
import {getProvider} from './llm/index';
import {getMode} from './modes';
import {notify} from './push';
import {outstanding} from './tools/reminders';
import {checkWatches} from './watch';
import {Document} from './store/index';

/**
 * Grace looking around while nobody is talking to her.
 *
 * The difference between an assistant and a chatbot is who starts the
 * conversation. This is the part that lets her start it: every few minutes she
 * looks at the diary, the inbox and the list, works out whether anything
 * genuinely wants the user, and says so once.
 *
 * Three rules shape all of it, and each of them exists because the failure
 * mode they prevent is what makes people switch these things off.
 *
 *  - Nothing is raised twice. Every concern carries a stable id and she keeps
 *    the ones she has already mentioned.
 *  - Nothing costs anything when nothing is happening. The language model is
 *    only called when there is something new to say, so an idle day is free.
 *  - She respects the mode she was put in. Focus means silence unless the roof
 *    is on fire; Away means it waits.
 */

export type Urgency = 'now' | 'soon' | 'whenever';

export interface Concern {
  id: string;
  kind: 'diary' | 'mail' | 'reminder' | 'watch';
  text: string;
  urgency: Urgency;
  at?: string;
}

interface Seen {
  /** Concern id to the time it was first raised. */
  raised: Record<string, string>;
}

const seen = new Document<Seen>('pulse', () => ({raised: {}}));

/** Anything starting inside this window is worth a word. */
const IMMINENT_MINUTES = 45;

/** How long a raised concern stays remembered before it could be raised again. */
const FORGET_AFTER_MS = 36 * 60 * 60 * 1000;

function minutesUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
}

/** The diary, the list, and the inbox — whatever of them is reachable. */
export async function gather(now = new Date()): Promise<Concern[]> {
  const concerns: Concern[] = [];

  // Watches first: a change is the whole reason a watch exists, and the
  // check is a fetch-and-compare with no model call, so an unchanged hour
  // costs nothing but the fetches.
  for (const change of await checkWatches().catch(() => [])) {
    concerns.push({
      id: `watch:${change.id}:${now.toISOString().slice(0, 13)}`,
      kind: 'watch',
      text: change.detail,
      urgency: 'soon',
    });
  }

  const overdue = await outstanding().catch(() => []);
  for (const reminder of overdue) {
    if (!reminder.due) continue;
    const minutes = minutesUntil(reminder.due);
    if (minutes > IMMINENT_MINUTES) continue;
    concerns.push({
      id: `reminder:${reminder.id}`,
      kind: 'reminder',
      text:
        minutes < 0
          ? `${reminder.text} — that was due ${Math.abs(minutes)} minutes ago`
          : `${reminder.text} — due in ${minutes} minutes`,
      urgency: minutes < 15 ? 'now' : 'soon',
      at: reminder.due,
    });
  }

  const google = await connection().catch(() => null);
  if (google && !google.brokenReason) {
    const [events, mail] = await Promise.all([
      upcoming(2, 5).catch(() => []),
      recentMail('in:inbox is:unread category:primary newer_than:1d', 5).catch(() => []),
    ]);

    for (const event of events) {
      if (event.allDay) continue;
      const minutes = minutesUntil(event.start);
      if (minutes < 0 || minutes > IMMINENT_MINUTES) continue;
      concerns.push({
        id: `diary:${event.id}`,
        kind: 'diary',
        text: `${event.summary} starts in ${minutes} minutes${
          event.location ? `, at ${event.location}` : ''
        }`,
        urgency: minutes <= 15 ? 'now' : 'soon',
        at: event.start,
      });
    }

    // Mail is the noisiest of the three, so it is deliberately the quietest:
    // one line about who wrote, never the contents, and never each message
    // separately. Anyone who wants their inbox read to them can ask.
    //
    // Newsletters and marketing are dropped outright. A person writing is
    // worth interrupting for; an advertisement never is, and treating the two
    // the same is how an assistant becomes something you mute.
    const real = mail.filter((message) => !message.bulk);
    if (real.length > 0) {
      const senders = [...new Set(real.map((message) => message.from.split('<')[0].trim()))];
      concerns.push({
        // Keyed on the newest message, so the same batch is one concern and a
        // genuinely new arrival is a new one.
        id: `mail:${real[0].id}`,
        kind: 'mail',
        text:
          real.length === 1
            ? `${senders[0]} wrote: ${real[0].subject}`
            : `${real.length} new emails, from ${senders.slice(0, 3).join(', ')}`,
        // Someone writing to you is worth a note on your phone; it is not
        // worth stopping you mid-sentence for.
        urgency: 'soon',
      });
    }

    // Deliveries move on their own and are the one automated message worth
    // knowing about — which is why this looks at everything, bulk included.
    const moving = mail.find((message) =>
      /(out for delivery|has shipped|is on the way|arriving today|delivered)/i.test(
        message.subject,
      ),
    );
    if (moving) {
      concerns.push({
        id: `delivery:${moving.id}`,
        kind: 'mail',
        text: `Delivery update: ${moving.subject}`,
        urgency: 'whenever',
      });
    }
  }

  void now;
  return concerns;
}

/** Drops anything already mentioned, and forgets what has gone stale. */
async function unraised(concerns: Concern[]): Promise<Concern[]> {
  const record = await seen.read();
  const cutoff = Date.now() - FORGET_AFTER_MS;

  const kept: Record<string, string> = {};
  for (const [id, at] of Object.entries(record.raised)) {
    if (new Date(at).getTime() > cutoff) kept[id] = at;
  }

  const fresh = concerns.filter((concern) => !kept[concern.id]);
  if (fresh.length === 0) {
    // Still worth writing back when entries expired, so the record can't grow
    // without bound on a busy inbox.
    if (Object.keys(kept).length !== Object.keys(record.raised).length) {
      await seen.write({raised: kept});
    }
    return [];
  }

  const now = new Date().toISOString();
  for (const concern of fresh) kept[concern.id] = now;
  await seen.write({raised: kept});
  return fresh;
}

/**
 * Whether she may interrupt, given the mode she was put in.
 *
 * Focus mode is the one that matters. The user chose it to be left alone, and
 * an assistant who honours that except when she has something interesting is
 * an assistant nobody leaves running.
 */
function mayInterrupt(mode: AttentionMode, urgency: Urgency): boolean {
  if (mode === 'away') return false;
  if (mode === 'focus') return urgency === 'now';
  if (mode === 'work') return urgency !== 'whenever';
  return true;
}

/**
 * Whether it is the middle of the night where the user is.
 *
 * Between eleven and seven, only something genuinely urgent gets through.
 * Everything else is still noticed, still recorded, and still waiting in the
 * morning — an assistant who wakes you to say a parcel shipped is one you
 * switch off, and then she is no use at all when something does matter.
 */
function overnight(now: Date): boolean {
  const hour = now.getHours();
  return hour >= 23 || hour < 7;
}

const RANK: Record<Urgency, number> = {now: 0, soon: 1, whenever: 2};

export interface PulseResult {
  /** Everything new, whether or not she is allowed to say it. */
  concerns: Concern[];
  /** The line to speak, or null when she is holding her tongue. */
  say: string | null;
  /** Why she is not speaking, when she isn't. Shown in the interface. */
  held: string | null;
  /**
   * The utterance, recorded in the conversation.
   *
   * It has to go in the log. If she says "your ten o'clock starts in twenty
   * minutes" and the user answers "move it", she needs to know what she just
   * said — an unprompted remark that leaves no trace makes the very next reply
   * incoherent.
   */
  message?: Message;
}

/**
 * One look around.
 *
 * Returns without spending anything at all when nothing is new, which is the
 * common case and the reason this can run every few minutes on a ten dollar
 * budget.
 */
export async function pulse({fromPage = false}: {fromPage?: boolean} = {}): Promise<PulseResult> {
  const fresh = await unraised(await gather());
  if (fresh.length === 0) return {concerns: [], say: null, held: null};

  for (const concern of fresh) {
    await noteDeed('noticed', concern.text, true);
  }

  const {mode} = await getMode();
  const now = new Date();
  const sorted = [...fresh].sort((left, right) => RANK[left.urgency] - RANK[right.urgency]);
  const speakable = sorted.filter(
    (concern) =>
      mayInterrupt(mode, concern.urgency) &&
      (!overnight(now) || concern.urgency === 'now'),
  );

  // The phone is the other half of this. Speaking aloud reaches someone in the
  // room; a notification reaches them when they are not, which is exactly the
  // case where holding her tongue would otherwise mean saying nothing at all.
  //
  // One notification, not one per item: everything found this hour goes out
  // together or not at all.
  //
  // Not for what a visible page is about to say aloud. She checks every couple
  // of minutes now, and a buzz in your pocket for every email she has just
  // told you about, at your own desk, is how a phone gets put face down.
  const spokenHere = new Set(fromPage ? speakable : []);
  const worthABuzz = sorted.filter(
    (concern) =>
      !spokenHere.has(concern) &&
      concern.urgency !== 'whenever' &&
      (!overnight(now) || concern.urgency === 'now'),
  );
  if (worthABuzz.length > 0) {
    await notify('Grace', worthABuzz.map((concern) => concern.text).join(' · ')).catch(
      () => 0,
    );
  }

  if (speakable.length === 0) {
    return {
      concerns: sorted,
      say: null,
      held: overnight(now)
        ? 'Holding this until morning.'
        : mode === 'away'
          ? 'Holding this until you are back.'
          : 'Not interrupting while you are heads-down.',
    };
  }

  const say = await compose(speakable).catch(() => fallback(speakable));
  await noteDeed('spoke', say, true);
  return {concerns: sorted, say, held: null, message: await record('grace', say, 'voice')};
}

/** When the model is unavailable, the plain facts still get through. */
function fallback(concerns: Concern[]): string {
  return concerns.map((concern) => concern.text).join('. ') + '.';
}

/**
 * One sentence, in her voice.
 *
 * No tools, no memory, no search — this is a rewrite of facts already in hand,
 * and the cheapest request she makes. Interrupting someone deserves better
 * phrasing than a list read aloud, and not much more than that.
 */
async function compose(concerns: Concern[]): Promise<string> {
  const said = await getProvider().complete({
    system:
      'You are Grace, a composed personal assistant, interrupting the person ' +
      'you work for because something wants their attention. Say it in one ' +
      'short spoken sentence — two at the very most, and only if there are ' +
      'genuinely two things. No preamble, no "just letting you know", no ' +
      'markdown, no lists. Plain speech, understated. Do not add anything you ' +
      'were not given.',
    turns: [
      {
        role: 'user',
        text: concerns.map((concern) => `- ${concern.text}`).join('\n'),
      },
    ],
    temperature: 0.4,
    maxOutputTokens: 120,
    fast: true,
  });

  return said.trim() || fallback(concerns);
}
