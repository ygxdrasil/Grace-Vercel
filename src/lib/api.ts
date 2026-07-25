import type {
  ActionCategory,
  ChatEvent,
  ConfirmationPolicy,
  GraceState,
  InputMode,
  Profile,
  ProfileEntry,
} from '../../shared/types.ts';

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

export async function setAddressAs(addressAs: string | null): Promise<Profile> {
  const response = await expectOk(
    await fetch('/api/profile/address', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({addressAs}),
    }),
  );
  return response.json();
}

export async function forgetEntry(id: string): Promise<Profile> {
  const response = await expectOk(
    await fetch(`/api/profile/${id}`, {method: 'DELETE'}),
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
  await fetch('/api/conversation/clear', {method: 'POST'});
}
