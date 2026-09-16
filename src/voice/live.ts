/**
 * A real conversation, rather than a series of recordings.
 *
 * The way she spoke until now was: record until you stop talking, send the
 * file, wait, get audio back, play it. That works, and it is not a
 * conversation. You cannot interrupt a recording that has already been sent,
 * she cannot hear you while she is speaking, and there is a gap between your
 * last word and her first that no amount of tuning removes, because the gap
 * is the round trip.
 *
 * This holds one connection open with audio moving both ways at once. She
 * hears you while she is talking, which is what makes interrupting her
 * possible, and she starts answering before you have finished the sentence.
 *
 * Two sample rates, which is the detail that breaks this if it is got wrong.
 * She listens at 16kHz and speaks at 24kHz. The microphone gives whatever the
 * machine feels like — usually 48kHz — so what goes up is resampled and what
 * comes down is not. Playing 24kHz audio at 16kHz makes her sound like a
 * recording of someone drowning, and the mistake is invisible in the code.
 */

const LISTENS_AT = 16_000;
const SPEAKS_AT = 24_000;

export type LiveState = 'closed' | 'opening' | 'ready' | 'listening' | 'speaking';

export interface LiveHandlers {
  onState?: (state: LiveState) => void;
  /** What you said, as she heard it. */
  onHeard?: (text: string) => void;
  /** What she said, as text, so it can be shown and remembered. */
  onSaid?: (text: string) => void;
  /** She reached for a tool. */
  onDoing?: (name: string) => void;
  onTrouble?: (detail: string) => void;
}

/**
 * Turns whatever the microphone produces into what she expects.
 *
 * Runs in an audio worklet rather than on the main thread: capture happens
 * every few milliseconds, and sharing a thread with React means the audio
 * stutters whenever anything renders. The worklet is written here as a string
 * because it must be a separate file to the browser but should not be a
 * separate file to a person reading this.
 */
const CAPTURE = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    // Roughly 40ms of audio per message. Smaller means more messages than the
    // socket wants; larger is audible as lag before she notices you speaking.
    this.target = Math.round(sampleRate / 25);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) this.buffer.push(channel[i]);

    while (this.buffer.length >= this.target) {
      const slice = this.buffer.splice(0, this.target);
      // Straight-line resample to 16kHz. Not the most faithful method there
      // is, and entirely good enough for speech — the model is listening for
      // words, not mastering a record.
      const ratio = sampleRate / ${LISTENS_AT};
      const out = new Int16Array(Math.floor(slice.length / ratio));
      for (let i = 0; i < out.length; i += 1) {
        const sample = slice[Math.floor(i * ratio)] ?? 0;
        // Clamped before scaling. Anything past 1 wraps around to the
        // opposite extreme once it is an integer, which sounds like a burst
        // of static exactly when someone raises their voice.
        const clamped = Math.max(-1, Math.min(1, sample));
        out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('capture', Capture);
`;

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  // In chunks, because apply() on a very large array overflows the stack —
  // which only happens on longer utterances and so survives every short test.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Int16Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export class LiveVoice {
  private socket: WebSocket | null = null;
  private audio: AudioContext | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** When the next piece of her speech should start, on the audio clock. */
  private playAt = 0;
  /** Everything currently queued to play, so it can all be stopped at once. */
  private playing = new Set<AudioBufferSourceNode>();
  private state: LiveState = 'closed';

  constructor(private readonly handlers: LiveHandlers = {}) {}

  private moveTo(state: LiveState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState?.(state);
  }

  async open(url: string, token: string, stream: MediaStream): Promise<void> {
    this.moveTo('opening');

    const audio = new AudioContext();
    // Browsers start suspended until a real gesture. Talking to her is one,
    // but the resume has to be asked for explicitly or nothing is ever heard.
    if (audio.state === 'suspended') await audio.resume();
    this.audio = audio;

    const worklet = URL.createObjectURL(new Blob([CAPTURE], {type: 'text/javascript'}));
    try {
      await audio.audioWorklet.addModule(worklet);
    } finally {
      URL.revokeObjectURL(worklet);
    }

    const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    this.socket = socket;

    socket.onmessage = (event) => this.heard(JSON.parse(String(event.data)));
    socket.onerror = () => this.handlers.onTrouble?.('the connection failed');
    socket.onclose = () => this.close();

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      window.setTimeout(() => reject(new Error('she did not pick up')), 10_000);
    });

    this.source = audio.createMediaStreamSource(stream);
    this.capture = new AudioWorkletNode(audio, 'capture');
    this.capture.port.onmessage = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'audio',
          data: toBase64(event.data as ArrayBuffer),
          mimeType: `audio/pcm;rate=${LISTENS_AT}`,
        }),
      );
    };
    // Connected to the destination through a silent gain, because some
    // browsers stop pulling audio through a worklet that goes nowhere.
    const silence = audio.createGain();
    silence.gain.value = 0;
    this.source.connect(this.capture).connect(silence).connect(audio.destination);

    this.moveTo('listening');
  }

  private heard(note: Record<string, unknown>): void {
    switch (note.type) {
      case 'ready':
        this.moveTo('listening');
        break;
      case 'heard':
        this.handlers.onHeard?.(String(note.text ?? ''));
        break;
      case 'said':
        this.handlers.onSaid?.(String(note.text ?? ''));
        break;
      case 'doing':
        this.handlers.onDoing?.(String(note.name ?? ''));
        break;
      case 'audio':
        this.play(String(note.data ?? ''));
        break;
      case 'interrupted':
        /*
         * You started talking over her.
         *
         * Everything already handed to the speakers keeps playing unless it
         * is explicitly stopped — a second or two of her continuing over the
         * top of you, which is the single thing that makes interrupting feel
         * broken rather than natural. She is not slow to stop. She stopped
         * immediately, and the sound was already out of her hands.
         */
        this.hush();
        this.moveTo('listening');
        break;
      case 'done':
        this.moveTo('listening');
        break;
      case 'trouble':
        this.handlers.onTrouble?.(String(note.detail ?? 'something went wrong'));
        break;
      default:
        break;
    }
  }

  private play(base64: string): void {
    const audio = this.audio;
    if (!audio || !base64) return;

    const pcm = fromBase64(base64);
    const buffer = audio.createBuffer(1, pcm.length, SPEAKS_AT);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = (pcm[i] ?? 0) / 0x8000;

    const node = audio.createBufferSource();
    node.buffer = buffer;
    node.connect(audio.destination);

    /*
     * Scheduled against the audio clock, not played on arrival.
     *
     * Chunks arrive in bursts over a network and playing each as it lands
     * leaves audible seams between them. Holding a running cursor and
     * starting each piece exactly where the last one ended makes it one
     * continuous voice. The small margin catches up when the network has
     * fallen behind, rather than trying to start in the past.
     */
    const now = audio.currentTime;
    this.playAt = Math.max(this.playAt, now + 0.04);
    node.start(this.playAt);
    this.playAt += buffer.duration;

    this.playing.add(node);
    node.onended = () => this.playing.delete(node);
    this.moveTo('speaking');
  }

  /** Stop talking, now, and throw away what has not been played. */
  private hush(): void {
    for (const node of this.playing) {
      try {
        node.stop();
      } catch {
        // Already finished on its own. Nothing to stop and nothing to report.
      }
    }
    this.playing.clear();
    this.playAt = 0;
  }

  /** Typed instead of spoken — in company, or when the microphone is refused. */
  say(text: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({type: 'text', text}));
    }
  }

  close(): void {
    this.hush();
    this.capture?.port.close();
    this.capture?.disconnect();
    this.source?.disconnect();
    // The socket is closed before the audio context, so that the last thing
    // she is told is that we have gone rather than nothing at all — an open
    // session is billed by the minute whether or not anyone is listening.
    try {
      this.socket?.close();
    } catch {
      // Already closing.
    }
    void this.audio?.close().catch(() => {});

    this.socket = null;
    this.capture = null;
    this.source = null;
    this.audio = null;
    this.moveTo('closed');
  }
}
