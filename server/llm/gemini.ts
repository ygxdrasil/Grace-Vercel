import {GoogleGenAI} from '@google/genai';
import type {GenerateContentConfig} from '@google/genai';
import type {GenerateRequest, LlmProvider} from './types';

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({apiKey});
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const response = await this.client.models.generateContentStream(
      this.params(request),
    );

    for await (const chunk of response) {
      if (chunk.text) yield chunk.text;
    }
  }

  async complete(request: GenerateRequest): Promise<string> {
    const response = await this.client.models.generateContent(
      this.params(request),
    );
    return response.text ?? '';
  }

  private params(request: GenerateRequest) {
    const config: GenerateContentConfig = {
      systemInstruction: request.system,
      temperature: request.temperature ?? 0.7,
      abortSignal: request.signal,
    };

    if (request.maxOutputTokens) {
      config.maxOutputTokens = request.maxOutputTokens;
    }

    if (request.json) {
      config.responseMimeType = 'application/json';
      config.responseSchema = request.json;
    }

    // Conversation should feel immediate; deliberation costs a beat of silence
    // that is far more noticeable when the reply is spoken aloud.
    if (request.fast) {
      config.thinkingConfig = {thinkingBudget: 0};
    }

    return {
      model: this.model,
      contents: request.turns.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{text: turn.text}],
      })),
      config,
    };
  }
}
