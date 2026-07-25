import {config} from '../config';
import {newSalt, seal, unseal} from '../crypto';
import {FileBackend} from './file';
import {RedisBackend, redisCredentials} from './redis';
import type {Backend} from './types';

let backend: Backend | null = null;

/**
 * Redis when it's configured, local disk otherwise. That single rule is what
 * lets the same build run on your machine and on serverless, where there is no
 * durable filesystem to write to.
 */
export function getBackend(): Backend {
  if (!backend) {
    const credentials = redisCredentials();
    backend = credentials
      ? new RedisBackend(credentials.url, credentials.token)
      : new FileBackend(config.dataDir);
  }
  return backend;
}

/** Test seam. */
export function setBackend(next: Backend | null): void {
  backend = next;
}

/** One JSON document, sealed on the way out and opened on the way in. */
export class Document<T> {
  /** Reused across writes so the scrypt key stays derived. */
  private salt: string | null = null;

  constructor(
    private readonly key: string,
    private readonly fallback: () => T,
  ) {}

  async read(): Promise<T> {
    const raw = await getBackend().read(this.key);
    if (raw === null) return this.fallback();

    try {
      const {plaintext, salt} = unseal(raw, config.secret);
      if (salt) this.salt = salt;
      return JSON.parse(plaintext) as T;
    } catch (error) {
      // Unreadable memory must not take Grace down, and must not be silently
      // overwritten either — set it aside and carry on empty.
      await getBackend().quarantine(this.key, raw);
      console.error(
        `[grace] could not read "${this.key}" (${(error as Error).message}). ` +
          'Set it aside and started fresh.',
      );
      return this.fallback();
    }
  }

  async write(value: T): Promise<void> {
    if (!this.salt) this.salt = newSalt();
    await getBackend().write(
      this.key,
      seal(JSON.stringify(value), config.secret, this.salt),
    );
  }

  async update(mutate: (current: T) => T): Promise<T> {
    const next = mutate(await this.read());
    await this.write(next);
    return next;
  }
}
