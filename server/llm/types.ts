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
  /**
   * Room for the reply itself, in tokens — not counting deliberation.
   *
   * Worth being exact about, because Gemini is not: on the 2.5 models the
   * thinking tokens are spent out of `maxOutputTokens`, so a ceiling of 2048
   * with a thinking budget of 4096 does not produce a well-considered short
   * answer. It produces no answer at all — she thinks until the ceiling and
   * stops, and what comes back is empty. The provider adds `think` on top of
   * this number so a caller can raise either one without the other quietly
   * cancelling it out.
   */
  maxOutputTokens?: number;
  /**
   * Deliberation tokens allowed before answering. See shared/effort.ts.
   *
   * Overrides `fast`. Zero is only safe with no tool attached — deciding to
   * use a tool is itself deliberation, so a budget of nothing leaves the tool
   * present and untouched.
   */
  think?: number;

  /**
   * Which model answers this particular turn.
   *
   * Absent means the one she normally thinks with. Set for the small number
   * of turns a day that are worth paying Pro rates for — a judgement made per
   * sentence in shared/effort.ts, not per session, because the alternative is
   * choosing once between an assistant that is slow and expensive about
   * "lights off" and one that is shallow about the questions that matter.
   */
  model?: string;
  /**
   * When to stop starting new rounds of tool calls, as an epoch millisecond.
   *
   * Not a cancellation — anything already running is left to finish. It stops
   * her *beginning* work she has no time to report on, and sends her straight
   * to the closing pass so the person waiting gets an answer about what she
   * did manage.
   *
   * This exists because the hosting kills the request at sixty seconds and
   * returns nothing at all. Eight rounds of a tool that talks to a light —
   * which now paces its commands and reads them back, so several seconds each
   * — passes that comfortably, and the failure is total: no reply, no
   * explanation, and the lights half-changed.
   */
  deadline?: number;
  /** Ask the provider to return JSON matching this shape. */
  json?: object;
  /** Disable model-side deliberation where supported, for latency. */
  fast?: boolean;
  /**
   * Let the model search the web when it judges that it needs to.
   *
   * Cannot be combined with `json`: providers disallow a forced response shape
   * alongside a search tool.
   */
  search?: boolean;
  /**
   * Called if the provider actually consulted the web for this reply.
   *
   * Grace is told not to narrate her searching, which is right — but it left
   * no way to tell a working connection from a broken one. The interface says
   * so quietly instead.
   */
  onGrounded?: () => void;
  /** Called when the web was wanted but could not be reached. */
  onSearchFailed?: (reason: string) => void;
  /** Function declarations she may call, in the provider's own shape. */
  tools?: unknown[];
  /** Runs one call and returns what to hand back to the model. */
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Told about each call so the interface can show it happening. */
  onToolUsed?: (name: string, summary: string) => void;
}

export interface TranscribeRequest {
  /** Base64 audio. WAV, because every browser can be made to produce it. */
  audio: string;
  mimeType: string;
  signal?: AbortSignal;
  /**
   * What was being talked about, and the names involved.
   *
   * Transcription of accented or hesitant speech improves enormously when the
   * model knows what the words are likely to be about — a name it has seen
   * once is recognised, and the same sound with no context is guessed at.
   */
  context?: string;
}

export interface SpeakRequest {
  text: string;
  signal?: AbortSignal;
  /** Override the configured voice for this one utterance — auditioning. */
  voice?: string;
}

export interface SpokenAudio {
  /** Base64 WAV, ready to hand straight to an audio element. */
  audio: string;
  mimeType: 'audio/wav';
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  stream(request: GenerateRequest): AsyncIterable<string>;
  complete(request: GenerateRequest): Promise<string>;
  /**
   * Turn spoken audio into text.
   *
   * Grace's hearing used to rely on the browser's own speech recognition,
   * which does not exist in Firefox or on iOS, routes audio through Google
   * regardless, and fails silently on an unhappy network. Doing it here works
   * anywhere a microphone does.
   */
  transcribe(request: TranscribeRequest): Promise<string>;
  /**
   * Say something out loud.
   *
   * Her voice used to be the browser's own speech synthesis, which is absent
   * on some platforms, silent until a user gesture on others, and a different
   * voice on every machine. Generating the audio here means she sounds like
   * herself everywhere, and a failure is something we can explain rather than
   * a silence nobody can account for.
   */
  speak(request: SpeakRequest): Promise<SpokenAudio>;
}
