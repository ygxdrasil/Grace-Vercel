/**
 * The seam between Grace and whichever model is behind her.
 *
 * Everything above this interface is provider-agnostic, so swapping Gemini for
 * Claude (or routing per task) is a matter of adding one file here.
 */

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface GenerateRequest {
  system: string;
  turns: Turn[];
  signal?: AbortSignal;
  /** Lower for extraction work, higher for conversation. */
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the provider to return JSON matching this shape. */
  json?: object;
  /** Disable model-side deliberation where supported, for latency. */
  fast?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  stream(request: GenerateRequest): AsyncIterable<string>;
  complete(request: GenerateRequest): Promise<string>;
}
