import type {Effort} from './effort';

/**
 * Her bearing — which is not a mood, and is not pretending to be one.
 *
 * The ask was for the screen to show her mood, with the acknowledgement that
 * she does not have one. That acknowledgement is the whole design problem: an
 * invented feeling would be a decoration that lies, and lies about this get
 * believed, because a face that says "cheerful" is very hard to read as
 * "nothing is being measured here".
 *
 * So this reports the thing a mood would stand in for. When you glance at
 * someone and judge their mood, what you are actually reading is how hard
 * they are concentrating, whether they are busy, and whether they are waiting
 * on you. All three of those are real about her and already measured:
 *
 *   effort   worked out per sentence in ./effort — a light switch gets a
 *            glance, a question about why something happened gets sixteen
 *            times the deliberation. That figure is her concentration.
 *   acting   whether she is in the middle of doing something to the world.
 *   waiting  whether something is sitting there needing you.
 *
 * The result reads the way a mood reads — one word, taken in at a glance,
 * from across a room — and every one of those words is true.
 *
 * Pure and kept in shared/ so the self-test can hold it to real combinations.
 */

export type Bearing =
  | 'dormant'
  | 'attentive'
  | 'brisk'
  | 'considering'
  | 'deliberating'
  | 'occupied'
  | 'speaking'
  | 'waiting on you';

export interface Reading {
  /** Nothing configured, or she is switched off. */
  offline?: boolean;
  /** The microphone is on and she is listening for her name. */
  listening?: boolean;
  /** She is mid-thought. */
  thinking?: boolean;
  /** Audio is coming out of the speakers. */
  speaking?: boolean;
  /** She is running a tool — doing something rather than saying something. */
  acting?: boolean;
  /** Something is waiting on an answer from you. */
  asking?: boolean;
  /** How hard she was told to think about the thing in front of her. */
  effort?: Effort;
}

/**
 * Deliberately ordered, not scored.
 *
 * The first version weighted these and picked a winner, which produced a
 * number nobody could predict and a label that changed for reasons no one
 * could explain. A plain order is worse at nuance and far better at being
 * trusted: if it says "waiting on you", it is because something is.
 */
export function bearingOf(reading: Reading): Bearing {
  if (reading.offline) return 'dormant';

  // Ahead of everything else. A question she has asked and you have not
  // answered outranks whatever she is doing, because it is the only state on
  // this list that you can do something about.
  if (reading.asking) return 'waiting on you';

  if (reading.acting) return 'occupied';
  if (reading.speaking) return 'speaking';

  if (reading.thinking) {
    if (reading.effort === 'hard') return 'deliberating';
    if (reading.effort === 'reflex') return 'brisk';
    return 'considering';
  }

  return reading.listening ? 'attentive' : 'dormant';
}

/**
 * How lit the word should be. Dormant is nearly out; waiting on you is the
 * one that should catch your eye from the other side of the room.
 */
export const BEARING_WEIGHT: Record<Bearing, number> = {
  dormant: 0.28,
  attentive: 0.6,
  brisk: 0.7,
  considering: 0.8,
  deliberating: 0.95,
  occupied: 0.85,
  speaking: 0.9,
  'waiting on you': 1,
};

/** The only bearing that wants the warm colour, because it wants answering. */
export function bearingWarns(bearing: Bearing): boolean {
  return bearing === 'waiting on you';
}
