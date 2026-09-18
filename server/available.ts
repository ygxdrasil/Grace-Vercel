import {bridgeStatus} from './bridge';
import {config} from './config';
import {githubConfigured} from './github';
import {lightsConfigured} from './lights';
import {connection} from './google/oauth';
import {psnToken} from './keys';
import {n8nConfigured} from './n8n';
import {devices} from './push';
import type {Available} from './tools/index';

/**
 * What is actually plugged in.
 *
 * She is offered only the tools that can run, which is both cheaper and more
 * truthful: a tool for a service with no key costs its description on every
 * request and then answers "GitHub is not connected" when she finally reaches
 * for it. Better that she never had it.
 *
 * Two properties matter and are easy to lose. It has to be *stable*, because
 * the tool list is part of the prompt prefix Gemini serves from cache at a
 * quarter of the price — a list that changes between requests is a list that
 * never gets the discount, which costs more than the tools it removed. And it
 * has to be *cheap*, because three document reads on every message is three
 * more than the free tier wants to give.
 *
 * So: connected or not, never online-right-now, and held for a few minutes.
 */

const HOLD_MS = 5 * 60_000;

let cached: {at: number; value: Available} | null = null;

export async function available(): Promise<Available> {
  if (cached && Date.now() - cached.at < HOLD_MS) return cached.value;

  const [google, bridge, phones] = await Promise.all([
    connection().catch(() => null),
    bridgeStatus().catch(() => ({seenAt: null})),
    devices().catch(() => 0),
  ]);

  const value: Available = {
    google: Boolean(google && !google.brokenReason),
    github: githubConfigured(),
    n8n: n8nConfigured(),
    playstation: Boolean(psnToken()),
    // Ever seen, not currently answering. A bridge that has checked in once is
    // a bridge the user has set up, and she should still be able to try and
    // report honestly that the laptop is not there — whereas a tool list that
    // changes every time a laptop sleeps would cost the cache discount daily.
    // And when she is running on the machine herself there is no bridge to
    // wait for — she is already there, so her own hands are always present.
    room: !config.deployed || Boolean(bridge.seenAt),
    phone: phones > 0,
    lights: lightsConfigured(),
  };

  cached = {at: Date.now(), value};
  return value;
}

/** Pasting a key should take effect now, not in five minutes. */
export function forgetAvailable(): void {
  cached = null;
}
