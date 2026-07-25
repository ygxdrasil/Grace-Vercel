import './env.ts';
import path from 'node:path';

/**
 * Grace reads her settings from the environment so the same build can run as a
 * local daemon or a hosted service without code changes.
 */
export const config = {
  apiKey: process.env.GEMINI_API_KEY ?? '',

  /** Flash is the free-tier workhorse. Override to trade cost for depth. */
  model: process.env.GRACE_MODEL ?? 'gemini-2.5-flash',

  /** Encrypts memory at rest, and signs login cookies. */
  secret: process.env.GRACE_SECRET,

  /** When set, Grace asks for this before she'll talk to anyone. */
  password: process.env.GRACE_PASSWORD ?? '',

  /** Where memory lives when running on local disk. */
  dataDir: process.env.GRACE_DATA_DIR ?? path.resolve(process.cwd(), '.grace'),

  port: Number(process.env.PORT ?? 3001),

  /** How many recent turns are replayed to the model verbatim. */
  verbatimTurns: 24,

  /** Once the log passes this many turns, older ones fold into a summary. */
  summarizeAfter: 40,

  /** Set GRACE_LEARN=false to stop Grace building a profile of you. */
  learnFromConversation: process.env.GRACE_LEARN !== 'false',

  /** True on Vercel and friends, where an open instance is a public one. */
  deployed: Boolean(process.env.VERCEL ?? process.env.GRACE_DEPLOYED),
} as const;

export function isConfigured(): boolean {
  return config.apiKey.length > 0;
}
