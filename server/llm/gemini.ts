import {GoogleGenAI} from '@google/genai';
import type {Content, GenerateContentConfig, Part} from '@google/genai';
import * as budget from '../budget';
import {THINKING} from '../../shared/effort';
import {config} from '../config';
import {chosenVoice} from '../keys';
import {thinkingFor} from './thinking';
import {vertexSettings} from './vertex';
import type {
  GenerateRequest,
  LlmProvider,
  SpeakRequest,
  SpokenAudio,
  TranscribeRequest,
} from './types';

const TRANSCRIBE_PROMPT = `Write out what is said in this recording.

The speaker may have a strong accent, may not be a native English speaker, and may hesitate, restart, or use imperfect grammar. Transcribe them accurately and charitably:

- Write the words they meant, not a phonetic imitation of how they came out. If someone says "I go yesterday to the shop", write that — do not correct their grammar, but do not mangle it further either.
- Keep their own words and word order. You are transcribing, not translating and not rewriting.
- Drop pure disfluencies — "um", "uh", false starts abandoned mid-word — since they add nothing when read back.
- Proper nouns matter most and are the hardest to hear. Use the context below to recognise names of people, places, and things rather than guessing at similar-sounding words.
- If a stretch is genuinely unintelligible, leave it out rather than inventing something plausible. A short accurate transcript beats a complete invented one.
- If the speaker uses another language entirely, transcribe it in that language.

Return only the words spoken, with ordinary punctuation. No preamble, no quotes, no speaker labels, no description of the audio, no notes about audio quality. If there is no speech at all, return nothing.`;

/**
 * How many times she may act before answering.
 *
 * Five was set when she had four tools and a round was almost always "look
 * something up, then answer". She has a great many more now, and the tasks
 * worth having her do are the ones that take several steps: check the diary,
 * then the mail it refers to, then the lights, then say something about all
 * three. Five rounds turned those into half an answer with no explanation,
 * because running out of rounds looks exactly like finishing.
 *
 * Eight, then — still a stop rather than a licence. This is not a budget, it
 * is a backstop against a model that has begun looping, and a loop is obvious
 * long before eight.
 */
const MAX_TOOL_ROUNDS = 8;

/**
 * Bills a response against the monthly cap.
 *
 * Fire-and-forget: what she spent is worth knowing, but a failure to write it
 * down must never cost the user their answer.
 */
interface Usage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  /** The slice of the prompt served from cache, billed at a quarter. */
  cachedContentTokenCount?: number;
}

function meter(model: string, usage: Usage | undefined): void {
  if (!usage) return;
  void budget
    .record(
      model,
      usage.promptTokenCount ?? 0,
      usage.candidatesTokenCount ?? 0,
      usage.cachedContentTokenCount ?? 0,
    )
    .catch(() => {});
}

/**
 * Which voice one utterance comes out in.
 *
 * The audition override wins, then the voice the user chose, then the default.
 * Exported bare so the self-test can prove the order — the first version of
 * the override was applied with a pattern that no longer matched this file,
 * silently changed nothing, and shipped: every audition played in the current
 * voice, and no test could have noticed because the logic lived inline.
 */
export function voiceFor(request: SpeakRequest): string {
  return request.voice || chosenVoice() || config.voice;
}

const SPEAK_DIRECTION =
  'Read the following aloud in a calm, warm, unhurried voice, the way a ' +
  'composed personal assistant would speak to someone they know well. Read ' +
  'only the text itself:';

/** Gemini labels its audio `audio/L16;codec=pcm;rate=24000`. */
function sampleRateOf(mimeType: string | undefined): number {
  const rate = Number(/rate=(\d+)/.exec(mimeType ?? '')?.[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : 24_000;
}

/**
 * The speech model hands back headerless 16-bit PCM, which no browser will
 * play. Forty-four bytes of WAV header in front of it and every one will.
 */
function wrapPcmAsWav(base64Pcm: string, sampleRate: number): string {
  const pcm = Buffer.from(base64Pcm, 'base64');
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM header length
  header.writeUInt16LE(1, 20); // uncompressed
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]).toString('base64');
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private client: GoogleGenAI;

  /** True when billed through Cloud, which is the only till the credits work at. */
  readonly onVertex: boolean;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    const vertex = vertexSettings();
    this.onVertex = vertex !== null;

    /*
     * Same SDK, same models, two doors.
     *
     * `vertexai: true` swaps the endpoint and the authentication underneath
     * without changing a single call site — which is the whole reason this
     * migration is a constructor change rather than a rewrite. Credentials go
     * in as an object rather than a file path, because Vercel has no
     * filesystem to put a key file on.
     */
    this.client = vertex
      ? new GoogleGenAI({
          vertexai: true,
          project: vertex.project,
          location: vertex.location,
          googleAuthOptions: {credentials: vertex.credentials},
        })
      : new GoogleGenAI({apiKey});
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    await budget.requireBudget();
    let spoken = false;

    try {
      // The conversation grows as she acts: each round may end in tool calls,
      // whose results are appended and the whole thing asked again, until she
      // has nothing left to do and simply answers.
      const history: Content[] = request.turns.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{text: turn.text}],
      }));

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        // Out of time to start anything else. Everything already done still
        // counts and is about to be reported; what is refused is only the
        // next round, which there is no time to act on and describe.
        if (round > 0 && request.deadline && Date.now() > request.deadline) {
          console.error('[grace] out of time for more tools; answering with what she has');
          break;
        }

        const response = await this.client.models.generateContentStream({
          ...this.params(request),
          contents: history,
        });

        const calls: {name: string; args: Record<string, unknown>}[] = [];
        /*
         * What the model said, kept exactly as it said it.
         *
         * On the 3.x line a functionCall part arrives carrying a
         * `thoughtSignature` — an encrypted crumb of the model's reasoning
         * state. Send the conversation back without it and the next request
         * is rejected outright: "Function call is missing a thought_signature
         * in functionCall parts."
         *
         * This used to rebuild the model's turn from the name and arguments
         * it had extracted, which is a perfectly reasonable thing to do and
         * silently discarded the signature, because the signature is on the
         * part rather than inside the call. So the parts are now kept
         * verbatim and handed straight back. The rule is simply that what
         * comes out of the model goes back into the model unedited.
         */
        const said: Part[] = [];
        // Usage is metered once, after the stream drains — never per chunk.
        // Gemini reports usageMetadata cumulatively on every chunk it sends,
        // so metering inside the loop billed a ten-chunk reply something like
        // ten times over. That single line was most of why she seemed to
        // spend so fast. The last chunk carries the final total; keep it.
        let usage: Usage | undefined;

        for await (const chunk of response) {
          if (chunk.candidates?.[0]?.groundingMetadata) request.onGrounded?.();
          if (chunk.usageMetadata) usage = chunk.usageMetadata;

          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (part.functionCall?.name) {
              calls.push({
                name: part.functionCall.name,
                args: (part.functionCall.args ?? {}) as Record<string, unknown>,
              });
              said.push(part);
            } else if (part.thoughtSignature || part.thought) {
              // A signature can also arrive on a part of its own. It is
              // opaque either way; the only correct handling is to carry it.
              said.push(part);
            }
          }

          if (chunk.text) {
            spoken = true;
            yield chunk.text;
          }
        }

        meter(request.model ?? this.model, usage);

        // Nothing to do: that was her answer.
        if (calls.length === 0 || !request.onToolCall) return;

        history.push({role: 'model', parts: said});

        const results = [];
        for (const call of calls) {
          const result = await request.onToolCall(call.name, call.args);
          request.onToolUsed?.(call.name, result);
          results.push({
            functionResponse: {name: call.name, response: {result}},
          });
        }
        history.push({role: 'user', parts: results});
      }

      /*
       * Out of rounds, and she has not answered yet.
       *
       * The loop used to simply return here, which meant a genuinely involved
       * task — the kind worth having an assistant for — ended in nothing at
       * all. Not an error and not a partial answer: an empty reply, indistinct
       * from her having decided to say nothing, and the layer above turned it
       * into "I drew a blank there." All the work was done. The mail had been
       * read, the diary checked, the lights set. She just never got a turn in
       * which to mention it.
       *
       * So the last word is taken away from the tools and given back to her:
       * one more pass with nothing to call, which leaves her no option but to
       * say what she found.
       */
      const {config: settings} = this.params({...request, tools: [], search: false});
      const closing = await this.client.models.generateContentStream({
        model: request.model ?? this.model,
        contents: history,
        config: settings,
      });

      let closingUsage: Usage | undefined;
      for await (const chunk of closing) {
        if (chunk.usageMetadata) closingUsage = chunk.usageMetadata;
        if (chunk.text) {
          spoken = true;
          yield chunk.text;
        }
      }
      meter(request.model ?? this.model, closingUsage);

      return;
    } catch (error) {
      // The daily allowance for grounded prompts is smaller than the one for
      // ordinary ones, and it runs out mid-day rather than at a boundary. An
      // assistant who goes mute the moment she cannot search is worse than one
      // who answers from what she already knows and says so.
      if (!request.search || spoken) throw error;
      console.error(
        '[grace] search unavailable, answering without it:',
        (error as Error).message,
      );
      // Silently dropping to an ungrounded answer is how "she says she cannot
      // reach the web" goes undiagnosed for days.
      request.onSearchFailed?.((error as Error).message);
    }

    const response = await this.client.models.generateContentStream(
      this.params({...request, search: false}),
    );
    let usage: Usage | undefined;
    for await (const chunk of response) {
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (chunk.text) yield chunk.text;
    }
    meter(request.model ?? this.model, usage);
  }

  async complete(request: GenerateRequest): Promise<string> {
    await budget.requireBudget();
    const response = await this.client.models.generateContent(
      this.params(request),
    );
    meter(request.model ?? this.model, response.usageMetadata);
    return response.text ?? '';
  }

  /**
   * A model that has been retired must not make her deaf.
   *
   * Google retires models on published dates and sometimes ahead of them —
   * the whole 2.0 line went in June, and the 2.5 line has a shutdown date
   * pencilled in with reports of it answering 404 early. Hearing runs on a
   * different, cheaper model than thinking, so it can vanish on its own while
   * everything else still works, and the symptom is the worst kind: she stops
   * understanding anything said aloud and there is nothing on screen to say
   * why.
   *
   * So a "no such model" is caught once and the attempt repeated with the
   * model she thinks with — which is demonstrably alive, because she is
   * answering. Slower and dearer for that turn, and she keeps her hearing.
   * Loud in the log, because this should be fixed rather than absorbed.
   */
  private goneMissing(error: unknown): boolean {
    const detail = (error as Error)?.message ?? '';
    return /404|NOT_FOUND|not found|no longer available|is not supported/i.test(detail);
  }

  async transcribe(request: TranscribeRequest): Promise<string> {
    try {
      return await this.transcribeWith(config.transcribeModel, request);
    } catch (error) {
      if (!this.goneMissing(error) || config.transcribeModel === this.model) throw error;

      console.error(
        `[grace] the transcription model ${config.transcribeModel} is gone ` +
          `(${(error as Error).message}); falling back to ${this.model}. ` +
          'Set GRACE_TRANSCRIBE_MODEL to something current.',
      );
      return this.transcribeWith(this.model, request);
    }
  }

  private async transcribeWith(
    model: string,
    request: TranscribeRequest,
  ): Promise<string> {
    await budget.requireBudget();
    const response = await this.client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {inlineData: {mimeType: request.mimeType, data: request.audio}},
            {
              text: request.context
                ? `${TRANSCRIBE_PROMPT}\n\nContext for recognising names and topics:\n${request.context}`
                : TRANSCRIBE_PROMPT,
            },
          ],
        },
      ],
      config: {
        // Transcription is not a creative task; drifting off the audio is the
        // one failure mode that matters.
        temperature: 0,
        abortSignal: request.signal,
        // Transcription has nothing to deliberate about, and this model is
        // 3.x, where a budget of zero is spelled differently.
        thinkingConfig: thinkingFor(model, 0),
      },
    });

    // Billed against whichever model actually did the work, not whichever one
    // was configured — a fallback that meters the wrong one hides its own cost.
    meter(model, response.usageMetadata);
    return (response.text ?? '').trim();
  }

  async speak(request: SpeakRequest): Promise<SpokenAudio> {
    await budget.requireBudget();
    const response = await this.client.models.generateContent({
      model: config.speechModel,
      // The instruction rides along with the words. The model reads the
      // direction and speaks only what follows it.
      contents: [
        {
          role: 'user',
          parts: [{text: `${SPEAK_DIRECTION}\n\n${request.text}`}],
        },
      ],
      config: {
        abortSignal: request.signal,
        responseModalities: ['AUDIO'],
        speechConfig: {
          // A pasted choice wins over the deploy-time default, like every key.
          voiceConfig: {prebuiltVoiceConfig: {voiceName: voiceFor(request)}},
        },
      },
    });

    meter(config.speechModel, response.usageMetadata);

    const part = response.candidates?.[0]?.content?.parts?.find(
      (candidate) => candidate.inlineData?.data,
    );
    const pcm = part?.inlineData?.data;
    if (!pcm) throw new Error('the speech model returned no audio');

    return {
      audio: wrapPcmAsWav(pcm, sampleRateOf(part.inlineData?.mimeType)),
      mimeType: 'audio/wav',
    };
  }

  /**
   * Public so the self-test can assert on the request that goes out, rather
   * than restating this logic and testing a copy of it.
   */
  params(request: GenerateRequest) {
    // Pro and Flash do not take the same thinking vocabulary, and Pro has no
    // `medium`. Whichever model is actually answering decides both.
    const answering = request.model ?? this.model;
    const config: GenerateContentConfig = {
      systemInstruction: request.system,
      temperature: request.temperature ?? 0.7,
      abortSignal: request.signal,
    };

    /*
     * Deliberation is paid for out of the output ceiling.
     *
     * On the 2.5 models the thinking tokens are spent against
     * maxOutputTokens, which makes the two settings quietly hostile to each
     * other: raise the thinking budget past the ceiling and she thinks until
     * she runs out and returns nothing whatsoever. Not an error, not a short
     * answer — an empty string, from a request that looks entirely reasonable.
     *
     * So the caller's number means what it says — room for the reply — and
     * whatever thinking was asked for is added on top of it here, once, where
     * the relationship between the two is visible.
     */
    const think = request.think;
    if (request.maxOutputTokens) {
      config.maxOutputTokens = request.maxOutputTokens + (think ?? 0);
    }

    if (request.json) {
      config.responseMimeType = 'application/json';
      config.responseSchema = request.json;
    } else if (request.tools?.length) {
      // Never both. Gemini rejects the combination outright — "Built-in tools
      // and Function Calling cannot be combined in the same request" — and
      // sending both once cost her the web the moment she was given hands.
      // Her own functions win, because searching is one of them.
      config.tools = [{functionDeclarations: request.tools}];
    } else if (request.search) {
      config.tools = [{googleSearch: {}}];
    }

    /*
     * How long she is allowed to think before speaking.
     *
     * Left to itself the default is dynamic, which on a plain "what's on
     * today" spends thousands of tokens working out that the answer is the
     * diary — seconds of silence for a decision that was never in doubt. So
     * it is always set, one way or the other.
     *
     * `think` is the considered figure, worked out per sentence in
     * shared/effort.ts. `fast` is the older blunt instrument and stays for the
     * background jobs that use it — extraction, summarising, style — where
     * there is nothing to deliberate about and nobody waiting.
     *
     * The floor exists because zero is only safe with no tool attached.
     * Deciding to use a tool *is* deliberation, so a budget of nothing leaves
     * the tool present and untouched: she answers from memory and then says,
     * quite correctly, that she cannot reach the web.
     */
    /*
     * The 3.x line changed how this is asked for, and the two ways are
     * mutually exclusive: sending both `thinkingBudget` and `thinkingLevel`
     * in one request is a 400, not a preference. So which one goes out is
     * decided by the model, in one place, in ./thinking.
     */
    if (think !== undefined) {
      config.thinkingConfig = thinkingFor(
        answering,
        config.tools ? Math.max(THINKING.reflex, think) : think,
      );
    } else if (request.fast) {
      config.thinkingConfig = thinkingFor(answering, config.tools ? THINKING.reflex : 0);
    }

    return {
      model: request.model ?? this.model,
      contents: request.turns.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{text: turn.text}],
      })),
      config,
    };
  }
}
