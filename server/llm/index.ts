import {config} from '../config';
import {GeminiProvider} from './gemini';
import type {LlmProvider} from './types';

let provider: LlmProvider | null = null;

/**
 * Grace runs on Gemini Flash today because it has the most workable free tier.
 * The provider interface exists so that decision stays reversible.
 */
export function getProvider(): LlmProvider {
  if (!provider) {
    provider = new GeminiProvider(config.apiKey, config.model);
  }
  return provider;
}

/**
 * Swap the model out from under Grace. Exists so the whole pipeline — memory,
 * persona, learning, streaming — can be exercised without a network call.
 */
export function setProvider(next: LlmProvider | null): void {
  provider = next;
}
