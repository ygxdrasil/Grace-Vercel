import {Document} from './store/index';

/**
 * What she has spent, and a hard stop before it becomes your problem.
 *
 * This used to be a monthly allowance: ten dollars, reset on the first, and
 * the worst case of getting it wrong was that she went quiet until the month
 * turned. That is no longer the shape of the risk.
 *
 * The billing account behind her is a *paid* account holding about $300 of
 * promotional credit that expires on 16 December 2026. Paid accounts do not
 * stop when the credit runs out. They keep working and charge the card. So
 * the failure mode is no longer "Grace goes quiet" — it is "Grace quietly
 * keeps spending real money", which nobody notices until the statement.
 *
 * Google's own budget alert does not help here, and it is important to be
 * clear about why: an alert sends an email. It does not close the tap. It is
 * a smoke detector, not a sprinkler.
 *
 * So the brake lives here, in front of every request, where it can actually
 * refuse. Two of them:
 *
 *   - the pool, which is the credit and must not be overrun;
 *   - the aftermath, which is what she is allowed to spend once the credit is
 *     gone or expired, and which is deliberately small.
 *
 * Counted from the token usage the provider actually reports, not estimated
 * from message lengths, and enforced before the request goes out rather than
 * after — because a limit that only tells you afterwards is not a limit.
 */

/**
 * Dollars per million tokens.
 *
 * These are the Vertex list prices as of September 2026. 3.8 Flash is on
 * introductory pricing until 31 December, after which it doubles — which is
 * two weeks after the credits expire, so the cheap period and the funded
 * period end at very nearly the same time. Worth knowing before planning
 * anything around the low number.
 */
const RATES: Record<string, {in: number; out: number}> = {
  'gemini-3.8-flash': {in: 0.75, out: 3.75},
  'gemini-3.1-pro': {in: 2, out: 12},
  'gemini-3.5-flash-lite': {in: 0.1, out: 0.4},
  'gemini-3.1-flash-tts-preview': {in: 0.5, out: 10},

  // The outgoing line. Kept priced until it shuts down on 20 October, because
  // an unpriced model is charged at the fallback below, and being wrong about
  // her spending in the fortnight before a migration is exactly when it
  // matters most to be right.
  'gemini-2.5-flash': {in: 0.3, out: 2.5},
  'gemini-2.5-flash-lite': {in: 0.1, out: 0.4},
  'gemini-2.5-flash-preview-tts': {in: 0.5, out: 10},
};

/** Anything unrecognised is charged at the dearest known rate, not ignored. */
const FALLBACK = {in: 4, out: 18};

/**
 * Whether a model has a real price here, rather than the fallback.
 *
 * Exists so the self-test can prove that every model she is configured to use
 * is actually priced. Being charged the dearest rate for a cheap model is the
 * safe direction to be wrong in, but it is still wrong: it would show her
 * spending several times what she was, and stop her against a cap she had not
 * reached.
 */
export function priceOf(model: string): {in: number; out: number} | null {
  return RATES[model] ?? null;
}

/** When the promotional credit expires and the card becomes live. */
export function poolExpiry(): Date {
  const set = process.env.GRACE_CREDITS_EXPIRE;
  const parsed = set ? new Date(set) : new Date('2026-12-16T00:00:00Z');
  return Number.isNaN(parsed.getTime()) ? new Date('2026-12-16T00:00:00Z') : parsed;
}

/** The whole promotional pool, in dollars. */
export function poolSize(): number {
  const set = Number(process.env.GRACE_CREDIT_POOL);
  return Number.isFinite(set) && set > 0 ? set : 300;
}

/**
 * What she may spend per month once the pool is gone.
 *
 * This is the auto-revert, and it is not a separate mechanism that has to
 * remember to fire — it is simply which limit applies once the date passes.
 * Nothing is scheduled, so nothing can fail to run.
 *
 * Small on purpose. After 16 December every dollar is a real dollar off a
 * real card, and the right default for money spent without anyone watching
 * is an amount that would be annoying rather than alarming to discover.
 */
export function afterwardsCap(): number {
  const set = Number(process.env.GRACE_MONTHLY_CAP);
  return Number.isFinite(set) && set > 0 ? set : 10;
}

export function creditsExpired(now = new Date()): boolean {
  return now >= poolExpiry();
}

export interface Spend {
  /** Calendar month this covers, as YYYY-MM. Resets monthly, after the pool. */
  month: string;
  dollars: number;
  requests: number;
  /** Total drawn from the promotional pool. Never resets. */
  pool: number;
  /**
   * Charged to the card this month. Separate from `dollars` on purpose.
   *
   * `dollars` is everything spent this calendar month, whoever paid. The
   * credit expires on the 16th, so on that morning December's `dollars`
   * already holds two weeks of credit-funded spend — comfortably over the
   * $10 card limit — and she would refuse to work before a cent had touched
   * the card. This counts only what the card has actually been asked for.
   */
  card: number;
  /** Where the money actually went, by model. Guessing at this cost a week. */
  byModel?: Record<string, number>;
  /** Set when a cap has been hit, so the reason survives a restart. */
  stoppedAt: string | null;
}

const store = new Document<Spend>('spend', () => ({
  month: currentMonth(),
  dollars: 0,
  requests: 0,
  pool: 0,
  card: 0,
  stoppedAt: null,
}));

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Cached so the check in front of every request costs nothing. */
let cached: Spend | null = null;

export async function spend(): Promise<Spend> {
  if (!cached) cached = await store.read();

  // A new month starts clean, including clearing any stop — but the pool
  // total carries across, because the pool is not monthly.
  if (cached.month !== currentMonth()) {
    cached = {
      month: currentMonth(),
      dollars: 0,
      requests: 0,
      pool: cached.pool ?? 0,
      card: 0,
      stoppedAt: null,
    };
    await store.write(cached);
  }
  return cached;
}

/**
 * Which limit is in force, and how much of it is left.
 *
 * One function so that the check in front of a request, the figure she quotes
 * when asked, and the wording of the refusal can never disagree with each
 * other — which they did, when the cap was read separately in three places.
 */
export interface Standing {
  /** 'pool' while the credit lasts, 'card' once it does not. */
  against: 'pool' | 'card';
  spent: number;
  limit: number;
  remaining: number;
  /** Rough share of the funded window elapsed, 0–1. Null once on the card. */
  elapsed: number | null;
}

export async function standing(now = new Date()): Promise<Standing> {
  const current = await spend();

  if (creditsExpired(now)) {
    const limit = afterwardsCap();
    const charged = current.card ?? 0;
    return {
      against: 'card',
      spent: charged,
      limit,
      remaining: Math.max(0, limit - charged),
      elapsed: null,
    };
  }

  const limit = poolSize();
  const expiry = poolExpiry().getTime();
  /*
   * The window is measured back from expiry rather than forward from a start
   * date, because the start date is the one fact nobody will remember to
   * update and getting it wrong silently skews every pacing figure. Ninety
   * days is the length of the offer.
   */
  const opened = expiry - 90 * 24 * 60 * 60 * 1000;
  const through = (now.getTime() - opened) / (expiry - opened);

  return {
    against: 'pool',
    spent: current.pool,
    limit,
    remaining: Math.max(0, limit - current.pool),
    elapsed: Math.max(0, Math.min(1, through)),
  };
}

export class OverBudget extends Error {
  constructor(readonly standing: Standing) {
    super(
      standing.against === 'pool'
        ? `I have used the whole $${standing.limit.toFixed(0)} of Google credit — ` +
            `about $${standing.spent.toFixed(2)} of it. I have stopped rather than ` +
            `letting it run onto your card. Raise GRACE_CREDIT_POOL if there is ` +
            `more credit than I know about.`
        : `I have spent about $${standing.spent.toFixed(2)} this month against a ` +
            `$${standing.limit.toFixed(0)} limit, and the Google credit is gone, so ` +
            `this would be your own money. I will start again next month, or you ` +
            `can raise the cap.`,
    );
    this.name = 'OverBudget';
  }
}

/** Throws rather than returning, so a caller cannot forget to check. */
export async function requireBudget(): Promise<void> {
  const now = await standing();
  if (now.remaining <= 0) throw new OverBudget(now);
}

export async function record(
  model: string,
  inputTokens: number,
  outputTokens: number,
  /** The slice of input served from the implicit cache, billed at 25%. */
  cachedTokens = 0,
): Promise<void> {
  const rate = RATES[model] ?? FALLBACK;
  const fresh = Math.max(0, inputTokens - cachedTokens);
  const cost =
    (fresh * rate.in + cachedTokens * rate.in * 0.25 + outputTokens * rate.out) /
    1_000_000;

  const current = await spend();
  const onPool = !creditsExpired();

  const next: Spend = {
    ...current,
    dollars: current.dollars + cost,
    // The pool only draws down while it is actually paying. After expiry the
    // spending is real money and belongs to the month, not to the credit.
    pool: (current.pool ?? 0) + (onPool ? cost : 0),
    card: (current.card ?? 0) + (onPool ? 0 : cost),
    requests: current.requests + 1,
    byModel: {
      ...current.byModel,
      [model]: (current.byModel?.[model] ?? 0) + cost,
    },
    stoppedAt: current.stoppedAt,
  };

  const spentNow = onPool ? next.pool : next.card;
  const limitNow = onPool ? poolSize() : afterwardsCap();
  if (spentNow >= limitNow) next.stoppedAt = current.stoppedAt ?? new Date().toISOString();

  cached = next;
  await store.write(next);
}
