import './env.ts';
import path from 'node:path';
import {vertexSettings} from './llm/vertex';

/**
 * Grace reads her settings from the environment so the same build can run as a
 * local daemon or a hosted service without code changes.
 */
export const config = {
  apiKey: process.env.GEMINI_API_KEY ?? '',

  /**
   * The model she thinks with.
   *
   * She spent her life so far on gemini-2.5-flash, which was the right choice
   * for a free tier and is now simply a dead end: the whole 2.5 line shuts
   * down on 20 October 2026. Staying would mean she stopped working one
   * Tuesday morning with no warning and no error anyone could read.
   *
   * 3.8 Flash is the replacement, and it is not a sideways move. It is the
   * first Flash that reasons in several steps and calls tools iteratively
   * rather than picking one and answering — which is exactly the thing she
   * was worst at, and exactly what the deliberation work in shared/effort.ts
   * was built to compensate for.
   *
   * On introductory pricing until 31 December, at half its 2027 rate.
   */
  model: process.env.GRACE_MODEL ?? 'gemini-3.8-flash',

  /**
   * The model she thinks with when the question deserves it.
   *
   * New. Until now every sentence went to the same model and the only dial
   * was how long it was allowed to deliberate — which bought her more
   * thinking, but never better thinking. A hard question got more tokens of
   * the same reasoning.
   *
   * Pro costs roughly three times Flash per token and is reserved for the
   * handful of turns a day that shared/effort.ts rates `hard`. Everything
   * else — every command, every ordinary exchange — stays on Flash, which is
   * what keeps the credits lasting ninety days instead of nine.
   */
  hardModel: process.env.GRACE_HARD_MODEL ?? 'gemini-3.1-pro',

  /**
   * The model that listens.
   *
   * Still the lightest thing that can do the job, for the reason worked out
   * when this was split off: a single spoken exchange is six or seven
   * requests, not one, and transcription is the one of them that is
   * transcription rather than judgement. The context hint — names and topic
   * in play — does most of the work a heavier model was being paid for.
   *
   * Reversible without a deploy: set GRACE_TRANSCRIBE_MODEL to the thinking
   * model. Do that the moment she starts getting names wrong, because that
   * is the cost this trade is made against.
   */
  transcribeModel: process.env.GRACE_TRANSCRIBE_MODEL ?? 'gemini-3.5-flash-lite',

  /**
   * The model that gives her a voice. Separate from the one that thinks.
   *
   * The `-preview` suffix is load-bearing and is not decoration: there is no
   * `gemini-3.1-flash-tts`, and asking for one answers 404 — the same shape of
   * error as a retired model, which is a miserable thing to debug. Google
   * ships TTS on the preview channel and has done for both generations.
   */
  speechModel: process.env.GRACE_SPEECH_MODEL ?? 'gemini-3.1-flash-tts-preview',

  /**
   * Which of the prebuilt voices she speaks in. Kore is composed and even,
   * which is the brief: calm, formal, unhurried.
   */
  voice: process.env.GRACE_VOICE ?? 'Kore',

  /** Encrypts memory at rest, and signs login cookies. */
  secret: process.env.GRACE_SECRET,

  /** When set, Grace asks for this before she'll talk to anyone. */
  password: process.env.GRACE_PASSWORD ?? '',

  /** Where memory lives when running on local disk. */
  dataDir: process.env.GRACE_DATA_DIR ?? path.resolve(process.cwd(), '.grace'),

  port: Number(process.env.PORT ?? 3001),

  /**
   * How many recent turns are replayed to the model verbatim.
   *
   * Raised because the commonest complaint about her was forgetting something
   * said a little while ago. Everything older is still reachable through
   * search_memory, but a wider window means she does not have to think to
   * reach for it — which is the difference between remembering and looking up.
   */
  verbatimTurns: 32,

  /** Once the log passes this many turns, older ones fold into a summary. */
  summarizeAfter: 48,

  /** Set GRACE_LEARN=false to stop Grace building a profile of you. */
  learnFromConversation: process.env.GRACE_LEARN !== 'false',

  /**
   * Where the machine holding her voice can be reached.
   *
   * Empty until the outpost exists, and empty is a supported state rather
   * than a broken one: without it she falls back to the older way of
   * speaking — record, transcribe, think, reply — which is slower and cannot
   * be interrupted, but works. A missing voice must degrade to a worse voice,
   * never to silence.
   */
  outpost: process.env.GRACE_OUTPOST_URL ?? '',

  /** The voice she speaks in during a live conversation. */
  liveModel: process.env.GRACE_LIVE_MODEL ?? 'gemini-3.8-live',

  /** True on Vercel and friends, where an open instance is a public one. */
  deployed: Boolean(process.env.VERCEL ?? process.env.GRACE_DEPLOYED),
} as const;

/**
 * Whether she can reach a model at all.
 *
 * Two ways now, and either will do: a Vertex project with a service account,
 * or an AI Studio key. The first is what the Cloud credits can pay for; the
 * second is what runs on a developer's laptop without a Cloud project. Asking
 * for both would make her harder to run for no benefit.
 */
export function isConfigured(): boolean {
  return config.apiKey.length > 0 || vertexSettings() !== null;
}
