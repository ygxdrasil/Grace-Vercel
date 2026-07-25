/**
 * Types shared between the Grace client and server.
 * Type-only, so it can be imported from either side without runtime cost.
 */

export type Speaker = 'user' | 'grace';

export type InputMode = 'voice' | 'text';

export interface Message {
  id: string;
  speaker: Speaker;
  text: string;
  /** ISO timestamp. */
  at: string;
  /** How the user delivered it. Grace's own messages inherit the mode she was asked in. */
  via: InputMode;
}

/** A durable thing Grace knows about you. */
export type MemoryKind = 'fact' | 'preference' | 'routine' | 'goal';

export interface ProfileEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  /** ISO timestamp of when Grace learned it. */
  learnedAt: string;
  /** `stated` = you said it outright. `inferred` = Grace worked it out. */
  source: 'stated' | 'inferred';
}

export interface Profile {
  /** How Grace addresses you, e.g. "sir". Null means no honorific. */
  addressAs: string | null;
  entries: ProfileEntry[];
  updatedAt: string;
}

/**
 * Categories of real-world action, each with its own confirmation policy.
 * Phase 1 ships the policy layer; later phases register actions against it.
 */
export type ActionCategory =
  | 'communication'
  | 'purchase'
  | 'calendar'
  | 'home'
  | 'security'
  | 'research';

export type ConfirmationPolicy = 'always' | 'high-risk' | 'never';

export interface ActionPolicy {
  category: ActionCategory;
  policy: ConfirmationPolicy;
  /** Set when the policy is a hard limit the user declared and Grace cannot relax. */
  locked?: boolean;
}

export interface GraceState {
  messages: Message[];
  profile: Profile;
  policies: ActionPolicy[];
  /** False when no API key is configured, so the UI can explain itself. */
  ready: boolean;
  model: string;
}

/** Server-sent events streamed from POST /api/chat. */
export type ChatEvent =
  | {type: 'delta'; text: string}
  | {type: 'done'; message: Message}
  | {type: 'learned'; entries: ProfileEntry[]}
  | {type: 'error'; message: string};
