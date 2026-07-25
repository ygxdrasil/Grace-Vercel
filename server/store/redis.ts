import {Redis} from '@upstash/redis';
import type {Backend} from './types';

/**
 * Grace's memory when she is deployed. Serverless has no durable disk, and
 * Redis is strongly consistent — which matters here, because she writes a
 * message and reads it straight back on the next turn.
 */
export class RedisBackend implements Backend {
  readonly name = 'Redis';
  private client: Redis;

  constructor(url: string, token: string) {
    this.client = new Redis({url, token});
  }

  private keyFor(key: string): string {
    return `grace:${key}`;
  }

  async read(key: string): Promise<string | null> {
    // Values are written as strings; ask for them back the same way rather
    // than letting the client guess at JSON.
    const value = await this.client.get<string>(this.keyFor(key));
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async write(key: string, value: string): Promise<void> {
    await this.client.set(this.keyFor(key), value);
  }

  async quarantine(key: string, value: string): Promise<void> {
    await this.client.set(`${this.keyFor(key)}:unreadable:${Date.now()}`, value);
  }
}

export function redisCredentials(): {url: string; token: string} | null {
  // Vercel's Upstash integration injects the KV_ names; the Upstash dashboard
  // hands out the UPSTASH_ ones. Accept either.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  return url && token ? {url, token} : null;
}
