import {createHmac} from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';
import {config} from './config';
import {matches} from './crypto';

const COOKIE = 'grace_session';
const SESSION_DAYS = 30;

export type AuthStatus =
  /** No password configured, and running somewhere private. */
  | 'open'
  /** Signed in. */
  | 'ok'
  /** Password needed. */
  | 'required'
  /** Deployed with no password set — refuse rather than serve her publicly. */
  | 'misconfigured';

/**
 * GRACE_SECRET if it exists, otherwise the password itself. Using the password
 * means changing it signs everyone out, which is the behaviour you'd want.
 */
function signingKey(): string {
  return config.secret ?? config.password;
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('hex');
}

function readCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function valid(token: string | null): boolean {
  if (!token) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  if (!matches(signature, sign(payload))) return false;

  const expires = Number(payload);
  return Number.isFinite(expires) && expires > Date.now();
}

export function issueSession(res: Response): void {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const token = `${expires}.${sign(String(expires))}`;

  const attributes = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86_400}`,
  ];
  // Secure would make the cookie unusable over plain http on localhost.
  if (config.deployed) attributes.push('Secure');

  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSession(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

export function authStatus(req: Request): AuthStatus {
  if (config.deployed && !config.password) return 'misconfigured';
  if (!config.password) return 'open';
  return valid(readCookie(req)) ? 'ok' : 'required';
}

const MISCONFIGURED_MESSAGE =
  'Grace is deployed without a password, so she is refusing to answer. ' +
  'Set GRACE_PASSWORD in the hosting environment and redeploy.';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const status = authStatus(req);

  if (status === 'ok' || status === 'open') {
    next();
    return;
  }

  if (status === 'misconfigured') {
    res.status(503).json({error: MISCONFIGURED_MESSAGE});
    return;
  }

  res.status(401).json({error: 'password required'});
}

/** Slows down guessing. A public URL invites it in a way localhost never did. */
export function pauseAfterFailure(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600));
}

export function checkPassword(candidate: string): boolean {
  return config.password.length > 0 && matches(candidate, config.password);
}
