import type {
  ActionCategory,
  AttentionMode,
  ChatEvent,
  DayView,
  GoogleStatus,
  ModeState,
  ConfirmationPolicy,
  GraceState,
  InputMode,
  Message,
  Profile,
  ProfileEntry,
  PulseResult,
  Workspace,
} from '../../shared/types.ts';
import type {Enrolment, Strictness} from '../../shared/voiceprint.ts';

export type SessionStatus = 'open' | 'ok' | 'required' | 'misconfigured';

/** Thrown when the session has lapsed, so the UI can show the lock screen. */
export class NeedsPassword extends Error {
  constructor() {
    super('password required');
    this.name = 'NeedsPassword';
  }
}

async function expectOk(response: Response): Promise<Response> {
  if (response.status === 401) throw new NeedsPassword();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {error?: string} | null;
    throw new Error(body?.error ?? `request failed (${response.status})`);
  }
  return response;
}

export async function fetchSession(): Promise<SessionStatus> {
  const response = await fetch('/api/session');
  const body = (await response.json()) as {status: SessionStatus};
  return body.status;
}

export async function login(password: string): Promise<void> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({password}),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {error?: string} | null;
    throw new Error(body?.error ?? 'could not sign in');
  }
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', {method: 'POST'});
}

export async function fetchState(): Promise<GraceState> {
  const response = await expectOk(await fetch('/api/state'));
  return response.json();
}

/**
 * Streams a reply. EventSource can't POST, so the SSE framing is parsed by hand
 * off the fetch body.
 */
export async function* streamChat(
  text: string,
  via: InputMode,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text, via}),
    signal,
  });

  await expectOk(response);
  if (!response.body) throw new Error('no response body to read');

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        yield JSON.parse(line.slice(5).trim()) as ChatEvent;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Asks Grace to think over what was just said — updating what she knows and
 * folding old turns into her summary. Runs after the reply so neither sits in
 * front of it.
 */
export async function reflect(): Promise<ProfileEntry[]> {
  const response = await fetch('/api/reflect', {method: 'POST'});
  if (!response.ok) return [];
  const body = (await response.json()) as {learned?: ProfileEntry[]};
  return body.learned ?? [];
}

/**
 * Send recorded speech to be turned into text.
 *
 * Done on the server so hearing works in browsers that have no speech
 * recognition of their own, and so a failure comes back as a readable message.
 */
export async function transcribe(
  audio: string,
  mimeType: string,
): Promise<string> {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({audio, mimeType}),
  });

  if (response.status === 401) throw new NeedsPassword();

  const body = (await response.json().catch(() => null)) as
    | {text?: string; error?: string}
    | null;

  if (!response.ok) throw new Error(body?.error ?? 'transcription failed');
  return (body?.text ?? '').trim();
}

/**
 * Ask for a line of speech back as audio.
 *
 * Generated on the server so Grace has one voice everywhere, rather than
 * whatever the browser happens to ship — or, on several of them, nothing.
 */
export async function speak(
  text: string,
  signal?: AbortSignal,
  /** Audition a voice without it becoming hers. */
  voice?: string,
): Promise<{audio: string; mimeType: string}> {
  const response = await fetch('/api/speak', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text, ...(voice ? {voice} : {})}),
    signal,
  });

  if (response.status === 401) throw new NeedsPassword();

  const body = (await response.json().catch(() => null)) as
    | {audio?: string; mimeType?: string; error?: string; detail?: string}
    | null;

  if (!response.ok || !body?.audio) {
    const failure = new Error(body?.error ?? 'speech failed');
    // Kept apart from the readable message so a diagnostic can show the
    // provider's own words without them leaking into ordinary notices.
    (failure as Error & {detail?: string}).detail = body?.detail;
    throw failure;
  }
  return {audio: body.audio, mimeType: body.mimeType ?? 'audio/wav'};
}

/**
 * Where to hold a conversation, if she can hold one at all.
 *
 * `live` is false whenever no outpost is configured, which is an ordinary
 * state rather than a fault: she then speaks the older way, by recording and
 * replying. The browser has to know which, because the two are completely
 * different machinery on this side — one holds a socket open and streams,
 * the other posts a file and waits.
 */
export interface VoiceKey {
  live: boolean;
  url: string;
  token: string | null;
  model: string;
}

export async function voiceKey(): Promise<VoiceKey> {
  try {
    const response = await fetch('/api/voice-key');
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch {
    // Unreachable is the same as unconfigured as far as this is concerned:
    // fall back to the way of speaking that does not need her to answer a
    // question first. A voice that fails closed is worse than a slower one.
    return {live: false, url: '', token: null, model: ''};
  }
}

export async function webCheck(): Promise<Record<string, unknown>> {
  const response = await expectOk(await fetch('/api/web-check', {method: 'POST'}));
  return response.json();
}

/**
 * One unprompted look around.
 *
 * Costs nothing when nothing has changed, which is why the client can afford
 * to ask every few minutes for as long as it is open.
 */
export async function pulse(): Promise<PulseResult> {
  const response = await fetch('/api/pulse', {method: 'POST'});
  if (!response.ok) return {concerns: [], say: null, held: null};
  return response.json();
}

/** What she says when you walk in. Null most of the time, by design. */
export async function greeting(): Promise<{say: string | null; message?: Message}> {
  const response = await fetch('/api/greeting', {method: 'POST'});
  if (!response.ok) return {say: null};
  return response.json();
}

export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

export async function fetchNotes(): Promise<Note[]> {
  const response = await fetch('/api/notes');
  if (!response.ok) return [];
  return ((await response.json()) as {notes: Note[]}).notes;
}

export async function saveNote(id: string, title: string, body: string): Promise<Note[]> {
  const response = await expectOk(
    await fetch('/api/note-save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id, title, body}),
    }),
  );
  return ((await response.json()) as {notes: Note[]}).notes;
}

export async function archiveNote(id: string): Promise<Note[]> {
  const response = await expectOk(
    await fetch('/api/note-archive', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    }),
  );
  return ((await response.json()) as {notes: Note[]}).notes;
}

export interface Situation {
  id: string;
  title: string;
  status: 'open' | 'resolved';
  updates: {at: string; text: string}[];
}

export async function fetchSituations(): Promise<Situation[]> {
  const response = await fetch('/api/situations');
  if (!response.ok) return [];
  return ((await response.json()) as {situations: Situation[]}).situations;
}

export interface WatchRow {
  id: string;
  what: string;
  keyword?: string;
  lastCheckedAt?: string;
}

export async function fetchWatches(): Promise<WatchRow[]> {
  const response = await fetch('/api/watches');
  if (!response.ok) return [];
  return ((await response.json()) as {watches: WatchRow[]}).watches;
}

/** Correcting what she has learned — the whole point of a memory you can see. */
export async function supersede(text: string): Promise<Profile> {
  const response = await expectOk(
    await fetch('/api/memory-supersede', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text}),
    }),
  );
  return response.json();
}

export interface Chat {
  id: string;
  title: string;
  at: string;
  lastAt: string;
}

export async function fetchChats(): Promise<{chats: Chat[]; current: string}> {
  const response = await expectOk(await fetch('/api/chats'));
  return response.json();
}

export async function newChat(): Promise<{chats: Chat[]; current: string}> {
  const response = await expectOk(await fetch('/api/chat-new', {method: 'POST'}));
  return response.json();
}

export async function openChat(id: string): Promise<{chats: Chat[]; current: string}> {
  const response = await expectOk(
    await fetch('/api/chat-open', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    }),
  );
  return response.json();
}

export async function archiveChat(
  id: string,
): Promise<{chats: Chat[]; current: string}> {
  const response = await expectOk(
    await fetch('/api/chat-archive', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    }),
  );
  return response.json();
}

export async function deepResearch(
  topic: string,
): Promise<{title: string; report: string; strands: string[]}> {
  const response = await expectOk(
    await fetch('/api/research', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({topic}),
    }),
  );
  return response.json();
}

export async function compactNow(): Promise<{folded: boolean; summary: string | null}> {
  const response = await expectOk(await fetch('/api/compact', {method: 'POST'}));
  return response.json();
}

export interface VoiceGuard {
  enrolment: Enrolment | null;
  on: boolean;
  strictness: Strictness;
}

export async function voiceGuard(): Promise<VoiceGuard> {
  const response = await expectOk(await fetch('/api/voice-guard'));
  return response.json();
}

export async function saveVoice(patch: {
  enrolment?: unknown;
  on?: boolean;
  strictness?: Strictness;
}): Promise<VoiceGuard> {
  // Two routes rather than one: enrolling carries a body that has to be
  // validated in its own right, and the settings must stay changeable even
  // when a browser sends a print the server will not accept.
  if (patch.enrolment) {
    await expectOk(
      await fetch('/api/voice-enrol', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({enrolment: patch.enrolment}),
      }),
    );
  }

  const response = await expectOk(
    await fetch('/api/voice-set', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({on: patch.on, strictness: patch.strictness}),
    }),
  );
  return response.json();
}

export async function forgetVoice(): Promise<VoiceGuard> {
  const response = await expectOk(
    await fetch('/api/voice-forget', {method: 'POST'}),
  );
  return response.json();
}

export async function fetchWorkspaces(): Promise<Workspace[]> {
  const response = await fetch('/api/workspaces');
  if (!response.ok) return [];
  return ((await response.json()) as {workspaces: Workspace[]}).workspaces;
}

export async function saveWorkspace(patch: Partial<Workspace>): Promise<Workspace[]> {
  const response = await expectOk(
    await fetch('/api/workspace-save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(patch),
    }),
  );
  return ((await response.json()) as {workspaces: Workspace[]}).workspaces;
}

export async function hideWorkspace(id: string): Promise<Workspace[]> {
  const response = await expectOk(
    await fetch('/api/workspace-hide', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    }),
  );
  return ((await response.json()) as {workspaces: Workspace[]}).workspaces;
}

export async function fetchDay(): Promise<DayView | null> {
  const response = await fetch('/api/day');
  if (!response.ok) return null;
  return response.json();
}

export type KeyName =
  | 'gemini'
  | 'govee'
  | 'googleClientId'
  | 'googleClientSecret'
  | 'ownerEmail'
  | 'psn'
  | 'github'
  | 'n8n'
  | 'n8nUrl'
  | 'voice';

export type KeyStatus = Record<
  KeyName,
  {set: boolean; pasted: boolean; hint: string | null}
>;

export async function fetchKeys(): Promise<KeyStatus> {
  const response = await expectOk(await fetch('/api/keys'));
  return response.json();
}

export async function saveKey(name: KeyName, value: string): Promise<KeyStatus> {
  const response = await expectOk(
    await fetch('/api/keys', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, value}),
    }),
  );
  return response.json();
}

export async function googleStatus(): Promise<GoogleStatus | null> {
  const response = await fetch('/api/google-status');
  if (!response.ok) return null;
  return response.json();
}

export async function disconnectGoogle(): Promise<void> {
  await fetch('/api/google-disconnect', {method: 'POST'});
}

export async function setAttentionMode(mode: AttentionMode): Promise<ModeState> {
  const response = await expectOk(
    await fetch('/api/mode', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({mode}),
    }),
  );
  return response.json();
}

export async function setAddressAs(addressAs: string | null): Promise<Profile> {
  const response = await expectOk(
    await fetch('/api/profile-address', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({addressAs}),
    }),
  );
  return response.json();
}

export async function forgetEntry(id: string): Promise<Profile> {
  const response = await expectOk(
    await fetch('/api/profile-forget', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id}),
    }),
  );
  return response.json();
}

export async function updatePolicy(
  category: ActionCategory,
  policy: ConfirmationPolicy,
): Promise<{error?: string}> {
  const response = await fetch('/api/policies', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({category, policy}),
  });
  return response.json();
}

export async function clearConversation(): Promise<void> {
  await fetch('/api/conversation-clear', {method: 'POST'});
}
