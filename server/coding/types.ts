/** One model's go at a coding job. A job may hold more than one. */
export interface Attempt {
  /** Which model made it, named so the user can see what they paid for. */
  by: string;
  ok: boolean;
  /**
   * True when it stopped and asked for someone better, rather than failing.
   *
   * Told apart from `ok: false` because the ladder cares about the difference:
   * handing over is the system working, and worth saying in those words rather
   * than reporting the cheap model as having failed at something it correctly
   * declined to botch.
   */
  handedOver: boolean;
  summary: string;
  seconds: number;
  /** How many files it actually wrote. Zero is a strong signal on its own. */
  edited: number;
  /** Dollars, where the runner can know. Gemini's is metered upstream. */
  cost?: number;
  turns?: number;
}
