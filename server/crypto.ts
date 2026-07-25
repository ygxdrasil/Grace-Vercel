import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

interface Envelope {
  v: 1;
  encrypted: boolean;
  salt?: string;
  iv?: string;
  tag?: string;
  data: string;
}

/**
 * scrypt is deliberately slow, so a derived key is kept for the life of the
 * process. Callers reuse a document's existing salt on rewrite, which keeps
 * this to one derivation per document rather than one per write.
 */
const keys = new Map<string, Buffer>();

function keyFor(secret: string, salt: string): Buffer {
  const id = `${salt}:${secret.length}`;
  let derived = keys.get(id);
  if (!derived) {
    derived = scryptSync(secret, Buffer.from(salt, 'hex'), 32);
    keys.set(id, derived);
  }
  return derived;
}

export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

/** Wraps a payload for storage, encrypting it when a secret is configured. */
export function seal(plaintext: string, secret: string | undefined, salt: string): string {
  if (!secret) {
    return JSON.stringify({v: 1, encrypted: false, data: plaintext} satisfies Envelope);
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyFor(secret, salt), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return JSON.stringify({
    v: 1,
    encrypted: true,
    salt,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64'),
  } satisfies Envelope);
}

export interface Unsealed {
  plaintext: string;
  /** Reused on the next write so the key stays derived. */
  salt: string | null;
}

export function unseal(raw: string, secret: string | undefined): Unsealed {
  const envelope = JSON.parse(raw) as Envelope;

  if (!envelope.encrypted) return {plaintext: envelope.data, salt: null};

  if (!secret) {
    throw new Error('stored data is encrypted but no GRACE_SECRET is set');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    keyFor(secret, envelope.salt!),
    Buffer.from(envelope.iv!, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag!, 'hex'));

  const plaintext =
    decipher.update(Buffer.from(envelope.data, 'base64')).toString('utf8') +
    decipher.final('utf8');

  return {plaintext, salt: envelope.salt!};
}

/** Comparison that doesn't leak the answer through how long it took. */
export function matches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still burn a comparison so length isn't distinguishable by timing.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
