import {checkNonce, issueNonce} from '../auth';
import {googleClient} from '../keys';
import {Document} from '../store/index';

/**
 * Google sign-in for Grace's mail and diary.
 *
 * Deliberately built on plain fetch rather than the googleapis package, which
 * unpacks to nearly two hundred megabytes and walks an index of every Google
 * API on import. Six endpoints do not justify that, and Vercel caps a function
 * at two hundred and fifty.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The narrowest set that does the job.
 *
 * `gmail.modify` is here so she can file, label, and mark things read: the
 * user asked for an assistant that tidies rather than one that reports.
 *
 * What is still not here is `https://mail.google.com/`, the scope that permits
 * permanent erasure. Without it, erasing mail is not merely forbidden — it is
 * impossible, which is the stronger of the two guarantees and the reason the
 * scope stays out however capable she becomes.
 *
 * Two limits cannot be expressed as scopes and are enforced in code instead.
 * Google publishes no draft-only scope, so `gmail.compose` carries the ability
 * to send; and `gmail.modify` carries the ability to move mail to the bin.
 * Nothing in this repository calls drafts.send, messages.send, or
 * messages.trash, no request anywhere adds the TRASH or SPAM label, and the
 * self-test fails if any of that ever stops being true.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
];

interface Connection {
  refreshToken: string;
  email: string;
  scopes: string[];
  connectedAt: string;
  /** Set when Google has stopped honouring the refresh token. */
  brokenReason?: string;
}

const store = new Document<Connection | null>('google', () => null);

/**
 * Warm-instance cache only. A cold start simply refreshes again, which costs
 * one round trip and nothing else.
 */
const accessTokens = new Map<string, {token: string; expiresAt: number}>();

export function googleConfigured(): boolean {
  const client = googleClient();
  return Boolean(client.id && client.secret);
}

/**
 * Must match what is registered in Google's console byte for byte.
 *
 * Never derived from VERCEL_URL: that is unique per deployment, so it would
 * produce a URL that is not registered and fail every time.
 */
export function redirectUri(): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host
    ? `https://${host}/api/google-callback`
    : // The port she is actually on. This was a fixed 3001, but the local
      // launcher runs her on 7766 — so Google sent the browser back to a port
      // nothing was listening on, and connecting could never succeed.
      `http://localhost:${process.env.PORT ?? 3001}/api/google-callback`;
}

export function authorizeUrl(): string {
  // Signed rather than stored. Starting the handshake and completing it are
  // two separate serverless invocations, quite possibly on different
  // instances, so anything kept in memory between them is gone by the time
  // the callback arrives — which would make connecting fail every time.
  const state = issueNonce('google-oauth');

  const params = new URLSearchParams({
    client_id: googleClient().id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    // Without offline there is no refresh token at all, and without consent
    // Google returns one only on the very first authorisation — which makes
    // every subsequent attempt look like it worked while leaving nothing to
    // reconnect with tomorrow.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(body).toString(),
  });
  return (await response.json()) as TokenResponse;
}

/** Read the email out of an id_token without verifying it — see the caller. */
function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return '';
  try {
    const payload = idToken.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
    };
    return json.email ?? '';
  } catch {
    return '';
  }
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly needsReconnect = false,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

export async function completeSignIn(
  code: string,
  state: string,
): Promise<{email: string}> {
  if (!checkNonce('google-oauth', state)) {
    throw new GoogleError('That sign-in link had expired. Start again.');
  }

  const token = await postToken({
    code,
    client_id: googleClient().id,
    client_secret: googleClient().secret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });

  if (token.error || !token.refresh_token) {
    throw new GoogleError(
      token.error_description ??
        token.error ??
        'Google returned no refresh token. Remove Grace at ' +
          'myaccount.google.com/permissions and try again.',
    );
  }

  const email = emailFromIdToken(token.id_token);

  // Single-user app: anyone who reaches the callback and consents with their
  // own Google account would otherwise be written into the owner's slot. The
  // id_token comes straight from Google's token endpoint over TLS, so reading
  // it without verifying the signature is sound here.
  const owner = googleClient().owner;
  if (owner && email && email.toLowerCase() !== owner.toLowerCase()) {
    throw new GoogleError(
      `This is Grace's owner's account only. Signed in as ${email}, expected ${owner}.`,
    );
  }

  await store.write({
    refreshToken: token.refresh_token,
    email,
    scopes: (token.scope ?? '').split(' ').filter(Boolean),
    connectedAt: new Date().toISOString(),
  });

  return {email};
}

export async function connection(): Promise<Connection | null> {
  return store.read();
}

/**
 * Powers granted since this connection was made.
 *
 * A refresh token carries the scopes it was minted with, so adding one to the
 * list above does nothing at all for an account that connected before — the
 * request simply fails with a 403 the user has no way to interpret. Naming the
 * gap lets the interface say "reconnect, she can file your mail now" instead.
 */
export async function missingScopes(): Promise<string[]> {
  const saved = await store.read();
  if (!saved) return [];
  return SCOPES.filter(
    (scope) => scope.includes('/auth/') && !saved.scopes.includes(scope),
  );
}

export async function disconnect(): Promise<void> {
  accessTokens.clear();
  await store.write(null);
}

/**
 * A usable access token, refreshing only when the cached one is nearly out.
 *
 * Google does not rotate refresh tokens on this flow, so the stored one stays
 * good until the user revokes it, changes their password, or leaves it unused
 * for six months.
 */
export async function accessToken(): Promise<string> {
  const saved = await store.read();
  if (!saved) throw new GoogleError('Google is not connected yet.', true);
  if (saved.brokenReason) throw new GoogleError(saved.brokenReason, true);

  const cached = accessTokens.get(saved.refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const token = await postToken({
    client_id: googleClient().id,
    client_secret: googleClient().secret,
    refresh_token: saved.refreshToken,
    grant_type: 'refresh_token',
  });

  if (token.error === 'invalid_grant') {
    // Terminal, never transient. Record why so the interface can say it.
    const reason =
      'Google has disconnected Grace — usually a changed password or a revoked ' +
      'permission. Reconnect to put it back.';
    await store.write({...saved, brokenReason: reason});
    throw new GoogleError(reason, true);
  }

  if (token.error || !token.access_token) {
    throw new GoogleError(token.error_description ?? 'Google refused the token.');
  }

  accessTokens.set(saved.refreshToken, {
    token: token.access_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  });
  return token.access_token;
}

/** Every Google request goes through here, so failures read the same way. */
export async function googleFetch(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = await accessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401) {
    throw new GoogleError('Google rejected that request. Try reconnecting.', true);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new GoogleError(
      `Google returned ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  return response.json();
}
