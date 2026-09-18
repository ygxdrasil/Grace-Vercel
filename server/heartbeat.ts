import {config} from './config';
import {noteDeed} from './journal';
import {notify} from './push';
import {pulse} from './pulse';

/**
 * Her own heartbeat, rather than a borrowed one.
 *
 * She could already look around while nobody was talking to her — the diary,
 * the inbox, the list, every hour — and that has been true for a while. What
 * was not true is where it ran. The loop lived in the browser, so her ability
 * to notice anything depended on a tab being open somewhere: close the window
 * and she stopped, not because anything failed but because nothing was left
 * running to fail.
 *
 * That was the right shape when she was a page talking to a serverless
 * function, which cannot hold a thought between requests. It is the wrong
 * shape now. She is a program on somebody's desk that stays up for weeks, so
 * the heartbeat belongs here, where it beats whether or not anyone is looking.
 *
 * Deliberately not clever. One interval, the same `pulse()` the browser was
 * calling, and everything it finds written where she will see it next time
 * she is asked. The interesting part of this feature was never the timer.
 */

/**
 * How often she looks, and why it is not more often.
 *
 * Every look reads the diary and the inbox; most find nothing and cost
 * nothing, because the model is only asked when there is something new to say.
 * Hourly is frequent enough that a meeting is never missed by more than that,
 * and rare enough that a day of silence is genuinely free.
 */
const EVERY_MS = Number(process.env.GRACE_PULSE_MS) || 60 * 60 * 1000;

/**
 * A pause before the first one.
 *
 * Starting up is the busiest moment she has — memory opening, the voice half
 * connecting, a browser possibly loading — and a language model call on top of
 * that buys nothing. Nothing is so urgent that it cannot wait a minute.
 */
const SETTLE_MS = 60 * 1000;

let beating: NodeJS.Timeout | null = null;

async function look(): Promise<void> {
  try {
    const found = await pulse();
    if (found.concerns.length === 0) return;

    /*
     * What she does with it, when there is nobody there.
     *
     * The browser could simply speak. This cannot, and pretending otherwise
     * would be the worst of it — a remark made to an empty room is not a
     * notice, it is a thing that did not happen.
     *
     * So: the journal, always, because that is what she reads back and what
     * the panel shows when somebody returns. And the phone, when there is one,
     * for the things that were worth interrupting a person over. A concern
     * that is neither spoken nor recorded has been noticed and then forgotten,
     * which is worse than not looking.
     */
    for (const concern of found.concerns) {
      await noteDeed('noticed', concern.text, true).catch(() => {});
    }

    if (found.say) {
      await notify('Grace', found.say).catch(() => {});
      console.log(`[grace] noticed: ${found.say}`);
    } else if (found.held) {
      console.log(`[grace] noticed ${found.concerns.length}, holding: ${found.held}`);
    }
  } catch (error) {
    // A loop that dies on one bad hour is a loop that was never running. The
    // next beat is a fresh attempt and the log is where this goes to be seen.
    console.error('[grace] heartbeat stumbled:', (error as Error).message);
  }
}

/**
 * Starts the heartbeat, if there is any point.
 *
 * Refuses on the deployed side rather than silently doing nothing: a
 * serverless function has no continuous existence to hang a timer on, and an
 * interval set in one would be an interval set in whichever instance happened
 * to answer a request, dying with it moments later.
 */
export function startHeartbeat(): boolean {
  if (config.deployed || beating) return false;

  const first = setTimeout(() => {
    void look();
    beating = setInterval(() => void look(), EVERY_MS);
  }, SETTLE_MS);

  // Held so it can be stopped, and unref'd so an idle heartbeat is never the
  // only reason a process refuses to exit.
  beating = first;
  first.unref?.();
  return true;
}

export function stopHeartbeat(): void {
  if (!beating) return;
  clearTimeout(beating);
  clearInterval(beating);
  beating = null;
}

/** Whether she is looking around on her own. Reported so the panel can say. */
export function beatingNow(): boolean {
  return beating !== null;
}
