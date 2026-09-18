/**
 * What the server may use from the bridge when Grace is running locally.
 *
 * The bridge is plain JavaScript on purpose — it is handed out as one
 * downloadable file that runs anywhere with no build step and no dependencies.
 * This describes the part of it the TypeScript side calls, so that using it
 * directly is checked rather than cast away.
 */

export interface HandsResult {
  ok: boolean;
  detail: string;
}

export function carryOut(
  action: string,
  arg?: string,
  command?: {body?: string; replace?: boolean},
): Promise<HandsResult>;

export function allowed(path: string): Promise<{
  ok: boolean;
  real: string;
  existed: boolean;
  why?: string;
}>;
