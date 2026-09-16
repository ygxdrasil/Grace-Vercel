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
  /**
   * How many times she has seen this hold true.
   *
   * Something noticed once and something noticed twenty times are not equally
   * true, and she should not treat them as though they were.
   */
  timesSeen?: number;
  lastSeenAt?: string;
  /**
   * Set when something later contradicted this.
   *
   * Superseded rather than deleted: that people change is itself worth
   * knowing, and deleting is the one thing that cannot be undone.
   */
  supersededAt?: string;
}

/** How she has learned to deal with this particular person. */
export interface StyleNote {
  id: string;
  text: string;
  learnedAt: string;
  timesSeen: number;
}

export interface Profile {
  /** How Grace addresses you, e.g. "sir". Null means no honorific. */
  addressAs: string | null;
  entries: ProfileEntry[];
  /** Not what she knows about you — how she has learned to talk to you. */
  style?: StyleNote[];
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

export interface GoogleStatus {
  /** Whether the keys are present at all. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  /** Set when Google has stopped honouring the connection. */
  problem: string | null;
  /** Shown during setup: this must match Google's console exactly. */
  redirectUri: string;
}

/** How much of your attention Grace may take. */
export type AttentionMode = 'open' | 'work' | 'focus' | 'away';

export interface ModeState {
  mode: AttentionMode;
  /** ISO timestamp of when this mode was entered. */
  since: string;
}

export interface GraceState {
  messages: Message[];
  profile: Profile;
  policies: ActionPolicy[];
  /** False when no API key is configured, so the UI can explain itself. */
  ready: boolean;
  model: string;
  mode: ModeState;
  /** What she has folded away from older conversations. Null before any. */
  summary: string | null;
  /** Where memory is kept, and whether it is encrypted at rest. */
  storage: {backend: string; encrypted: boolean};
  /** What she has spent against whichever limit is currently in force. */
  spend: {
    dollars: number;
    cap: number;
    requests: number;
    /**
     * Which pot is paying: Google's promotional credit, or the card behind
     * it. The distinction is the whole difference between "spending fast" and
     * "spending your money", and a bare dollar figure carries neither.
     */
    against: 'pool' | 'card';
    /** Drawn from the credit pool so far. Equals `dollars` only on the card. */
    pool: number;
    remaining: number;
    /** How far through the funded window, 0–1. Null once the credit is gone. */
    elapsed: number | null;
    /** Where it went — chat, speech, transcription — so nobody guesses. */
    byModel?: Record<string, number>;
  };
}

/** Something Grace noticed that may want the user. */
export interface Concern {
  id: string;
  kind: 'diary' | 'mail' | 'reminder' | 'watch';
  text: string;
  urgency: 'now' | 'soon' | 'whenever';
  at?: string;
}

export interface PulseResult {
  concerns: Concern[];
  /** What she would say aloud, or null if she is holding it. */
  say: string | null;
  held: string | null;
  /** What she said, recorded in the conversation so the next reply follows on. */
  message?: Message;
}

/** One thing she did, for the record. */
export interface JournalEntry {
  id: string;
  at: string;
  kind: 'acted' | 'noticed' | 'learned' | 'spoke';
  text: string;
  unprompted?: boolean;
}

export interface PlayStationPresence {
  online: boolean;
  status: string;
  playing: string | null;
  platform: string | null;
  lastOnline: string | null;
}

/** Everything the dashboard's three panels are built from. */
export interface DayView {
  google: boolean;
  events: {
    id: string;
    summary: string;
    location: string;
    start: string;
    end: string;
    allDay: boolean;
  }[];
  mail: {id: string; from: string; subject: string; date: string}[];
  reminders: {id: string; text: string; due: string | null}[];
  deeds: JournalEntry[];
  playstation: PlayStationPresence | null;
}

/**
 * One room of the app: a tab in the rail, and a mode she can be put into.
 *
 * Data rather than code, so new ones can be added without a deploy.
 */
export interface Workspace {
  id: string;
  name: string;
  /** Names a lucide icon; unknown names fall back to a dot. */
  icon: string;
  /** Which colour the app takes on while you are in here. */
  accent: 'ice' | 'amber' | 'violet' | 'rose';
  /** Pages opened when you switch into it, in order. The first is focused. */
  opens: string[];
  /** Which panels this room shows, by name. */
  panels: string[];
  blurb?: string;
  /** What she should say when you arrive, if anything. */
  brief?: string;
  /** Hidden rather than deleted — nothing here is ever destroyed. */
  hidden?: boolean;
}

/** One tappable answer to something she asked. */
export interface Choice {
  label: string;
  detail?: string;
}

/** Server-sent events streamed from POST /api/chat. */
export type ChatEvent =
  | {type: 'delta'; text: string}
  | {type: 'done'; message: Message}
  | {type: 'learned'; entries: ProfileEntry[]}
  | {type: 'searched'}
  | {type: 'search-failed'; reason: string}
  | {type: 'acted'; name: string; summary: string}
  | {type: 'asked'; question: string; choices: Choice[]}
  | {type: 'open'; urls: string[]; workspace?: string}
  | {type: 'error'; message: string};
