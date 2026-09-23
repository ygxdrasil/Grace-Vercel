import {useCallback, useEffect, useRef, useState} from 'react';
import * as api from '../lib/api';
import {acquire, MicError, type MicLease} from './mic';
import {wavFromSamples} from './wav';
import {keepUpWithSamples, wasYouSamples, type GuardState} from './voiceprint';
import {printOf} from '../../shared/voiceprint';
import {heardName, isPhantom, toldToSleep} from '../../shared/wake';

/**
 * Always-on listening.
 *
 * The microphone stays open, speech is detected here on the machine, and
 * nothing leaves the room until someone has actually said something — at which
 * point the utterance is transcribed and checked for her name. Silence, typing,
 * traffic and television never travel anywhere.
 *
 * Deliberately not the browser's speech recognition: that streams continuously
 * to a remote service, holds the microphone against everything else that wants
 * it, and stops on its own schedule without saying so. This is the thing it was
 * pretending to be.
 *
 * The listening itself happens on the audio thread, in a worklet, and that is
 * the whole reason she can still hear you while you are reading something else.
 * This loop used to run on requestAnimationFrame, which every browser stops
 * dead for a tab you are not looking at — so the moment you opened another
 * site she went deaf, and came back the instant you returned, which is a very
 * confusing thing to experience. An AudioWorklet is driven by the soundcard
 * rather than the screen. It does not know or care whether anyone is watching.
 *
 * The limit that remains is real and worth being straight about: her tab has to
 * be open somewhere. A page that has been closed is not running, and no amount
 * of cleverness changes that — hearing you with the browser shut would need a
 * browser extension or a program installed on the machine.
 */

/**
 * Where the ear lives: public/worklets/ears.js.
 *
 * It was a string handed over as a blob URL, which her own security policy
 * refuses — worklet modules count as scripts, and script-src does not allow
 * blob:. It failed to load every time, the watchdog fell back to the frame
 * clock, and she went deaf whenever the tab lost focus.
 */
const EARS_URL = '/worklets/ears.js';

const CALIBRATION_MS = 600;
/**
 * The quietest thing she will ever treat as speech.
 *
 * Was 0.012, which is a normal voice close to a laptop. A voice from across a
 * room arrives at a third of that, so the floor was the reason for having to
 * lean in and raise your voice — she was not mishearing it, she was never
 * being handed it at all.
 */
const SPEECH_FLOOR = 0.004;
/**
 * Silence that ends an utterance.
 *
 * Paid in full on every single spoken request, before anything else begins —
 * she cannot start transcribing until she believes you have stopped. Eleven
 * hundred milliseconds is longer than the pause most people leave between
 * sentences, so it was buying patience nobody had asked for.
 *
 * Seven hundred still comfortably clears a mid-sentence breath, and the cost of
 * being wrong is small in a way worth stating: if she cuts in early, the rest
 * of what you said arrives as the next utterance and — because she stays awake
 * for twelve seconds after being addressed — is treated as a follow-up rather
 * than lost.
 */
const TRAILING_SILENCE_MS = 700;
/** Anything shorter is a cough, a door, or a keyboard. */
const MIN_UTTERANCE_MS = 320;
/** Nobody speaks a single sentence for this long; stop and take what we have. */
const MAX_UTTERANCE_MS = 15_000;

/** How long she stays awake after being addressed, so follow-ups need no name. */
const STAYS_AWAKE_MS = 12_000;

export type AmbientState = 'off' | 'starting' | 'listening' | 'hearing' | 'working';

interface AmbientOptions {
  enabled: boolean;
  /** Deaf while she is thinking or talking, so she never answers herself. */
  paused: boolean;
  deviceId?: string;
  onRequest: (text: string) => void;
  /** Whose voice she answers to, when that has been set up. */
  guard?: GuardState | null;
  /** True while audio is actually coming out of the speakers. */
  speaking?: boolean;
  /** Called when her name is said mid-sentence: stop talking, listen. */
  onBargeIn?: () => void;
  /** Called when she has been told to leave it, so the room can acknowledge. */
  onSleep?: () => void;
}

export function useAmbient({
  enabled,
  paused,
  deviceId,
  onRequest,
  guard,
  speaking,
  onBargeIn,
  onSleep,
}: AmbientOptions) {
  const [state, setState] = useState<AmbientState>('off');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [awake, setAwake] = useState(false);
  /** The last thing she heard, whether or not it was for her. */
  const [heard, setHeard] = useState('');
  /** Voices turned away in a row. Reset the moment she recognises you. */
  const [strangers, setStrangers] = useState(0);
  /** Which clock is driving detection, so a diagnosis needs no guesswork. */
  const [ear, setEar] = useState<'none' | 'worklet' | 'frames'>('none');
  /** The last speaker verdict, for the same reason. */
  const [lastScore, setLastScore] = useState<number | null>(null);
  /** Told to leave it. Shown, because a silent assistant needs a reason. */
  const [dormant, setDormant] = useState(false);
  /*
   * Why the last thing she heard came to nothing.
   *
   * There are six separate ways a sentence can be picked up and then quietly
   * dropped, and from outside they are one symptom: she did not answer. Each
   * of them was a bare `return`. This is the difference between "she cannot
   * hear me" and "the voice lock does not recognise me" — two faults with
   * nothing in common and, until now, the same appearance.
   */
  const [dropped, setDropped] = useState<string | null>(null);

  const leaseRef = useRef<MicLease | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const earsRef = useRef<AudioWorkletNode | null>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const awakeUntilRef = useRef(0);
  const onRequestRef = useRef(onRequest);
  const pausedRef = useRef(paused);
  const runningRef = useRef(false);
  const guardRef = useRef<GuardState | null>(null);
  const speakingRef = useRef(false);
  const onBargeInRef = useRef(onBargeIn);
  const onSleepRef = useRef(onSleep);
  /** Hearing, and deliberately doing nothing about it until her name. */
  const dormantRef = useRef(false);
  /** Lets the blob path reach the sample path without a circular dependency. */
  const considerRef = useRef<(samples: Float32Array, rate: number) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    onRequestRef.current = onRequest;
  }, [onRequest]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  // Held in a ref for the same reason as the rest: `consider` is created once
  // and must see the current setting, not the one in force when it was made.
  useEffect(() => {
    guardRef.current = guard ?? null;
  }, [guard]);
  useEffect(() => {
    speakingRef.current = Boolean(speaking);
  }, [speaking]);
  useEffect(() => {
    onBargeInRef.current = onBargeIn;
  }, [onBargeIn]);
  useEffect(() => {
    onSleepRef.current = onSleep;
  }, [onSleep]);

  const stop = useCallback(() => {
    runningRef.current = false;
    window.cancelAnimationFrame(frameRef.current ?? 0);
    earsRef.current?.port.close();
    earsRef.current?.disconnect();
    earsRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    leaseRef.current?.release();
    leaseRef.current = null;
    setState('off');
    setLevel(0);
    setAwake(false);
    setEar('none');
  }, []);

  /**
   * Decide what to do with something that was said.
   *
   * Her name anywhere in the sentence counts, because "sorry Grace, what time
   * is it" is how people actually talk. Once addressed she stays awake briefly,
   * so a follow-up needs no name at all.
   */
  /** The fallback's route in: decode the blob, then exactly the same path. */
  const considerBlob = useCallback(
    async (audio: Blob) => {
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(await audio.arrayBuffer());
        await considerRef.current(decoded.getChannelData(0), decoded.sampleRate);
      } catch (cause) {
        console.warn('[grace] could not read the recording:', (cause as Error).message);
      } finally {
        await context.close().catch(() => {});
      }
    },
    [],
  );

  const consider = useCallback(async (samples: Float32Array, rate: number) => {
    setState('working');
    try {
      /*
       * Was that a voice at all?
       *
       * Asked here, before anything is sent, because a transcriber handed a
       * second of room tone does not answer "nothing" — it answers with
       * whatever phrase most often accompanied silence in its training data,
       * confidently. That is where "I created" comes from: nobody said it, and
       * no amount of filtering afterwards is as good as not asking.
       *
       * The test is periodicity. A voice has a pitch because vocal folds open
       * and close at a rate; a fan, a road, a keyboard and a room have none.
       * Long clips are let through regardless of pitch, because a whisper and
       * a sigh are real speech with little periodicity in them, and by then
       * there is enough evidence that something happened.
       */
      const shape = printOf(samples, rate);
      if (shape.pitch === 0 && shape.seconds < 1.2) {
        setDropped('not a voice');
        setState('listening');
        return;
      }

      const wav = wavFromSamples(samples, rate);

      /*
       * Whose voice it was, decided here, before anything leaves the machine.
       *
       * Deliberately ahead of transcription rather than after it. Checking
       * afterwards would mean every word the television says is sent away and
       * paid for before being thrown out — this way somebody else's voice
       * costs nothing at all, which makes the guard cheaper than not having it.
       */
      const guarding = guardRef.current ?? {
        enrolment: null,
        on: false,
        strictness: 'normal' as const,
      };
      const speaker = wasYouSamples(guarding, samples, rate);
      if (guarding.on && guarding.enrolment) setLastScore(speaker.score);
      if (!speaker.ok) {
        // Counted, not just noted. One refusal is the television; several in a
        // row is the owner being locked out of their own house, and the
        // interface has to be able to say so — the first version failed
        // silently, which left no way to tell the two apart.
        setStrangers((count) => count + 1);
        setDropped('another voice');
        return;
      }
      setStrangers(0);
      void keepUpWithSamples(guarding, samples, rate);

      const text = (await api.transcribe(wav.base64, wav.mimeType)).trim();
      if (!text) {
        setDropped('no words in it');
        return;
      }

      // The last line of defence, for when something did get through that
      // sounded periodic enough. Whole-utterance only, so "thank you" said to
      // her still reaches her while a lone "Thank you." from an empty room
      // does not — and it is not even shown, because a phantom appearing in
      // "last words she made out" is how this got noticed as a fault at all.
      if (isPhantom(text)) {
        setDropped('nothing was said');
        return;
      }

      setHeard(text);

      const {called, request} = heardName(text);
      const stillAwake = Date.now() < awakeUntilRef.current;

      /*
       * Interrupting her.
       *
       * Saying her name while she is talking stops her, immediately, and what
       * follows is treated as the next thing asked. That is how you cut a
       * person off mid-sentence and it is the only natural way to do it — the
       * alternative is waiting politely for a machine to finish reading out
       * something you already have the answer to.
       *
       * Only her name will do it. Any loud noise would mean the television
       * could silence her, and a stray cough would lose you the answer.
       */
      if (called && onBargeInRef.current) onBargeInRef.current();

      /*
       * Asleep: she hears, and does nothing about it, until her name.
       *
       * Not the microphone switched off — she has to keep listening or there
       * would be nothing to wake her. What stops is everything after: no
       * model, no reply, no noise. Saying her name is the whole of what gets
       * through, and it wakes her in the same breath as the request, so
       * "Grace, lights on" both wakes her and turns the lights on.
       *
       * Worth being straight about the cost: with no wake-word engine running
       * on the machine, deciding whether her name was said still means
       * transcribing. Asleep is quiet, not free.
       */
      if (dormantRef.current) {
        if (!called) {
          setDropped('asleep — say her name');
          return;
        }
        dormantRef.current = false;
        setDormant(false);
      }

      if (!called && !stillAwake) {
        setDropped('her name was not in it');
        return;
      }
      setDropped(null);

      // Told to leave it. Answered here rather than by the model: "go to
      // sleep" followed by a thoughtful paragraph about going to sleep is a
      // joke at her expense, and this has to work at the moment something has
      // gone wrong, which is when a round trip is least dependable.
      if (toldToSleep(request)) {
        dormantRef.current = true;
        setDormant(true);
        awakeUntilRef.current = 0;
        setAwake(false);
        onSleepRef.current?.();
        return;
      }

      // Just her name and nothing else: she is being got, not asked.
      if (!request) {
        awakeUntilRef.current = Date.now() + STAYS_AWAKE_MS;
        setAwake(true);
        return;
      }

      awakeUntilRef.current = 0;
      setAwake(false);
      onRequestRef.current(called ? request : text);
    } catch (cause) {
      // A failed transcription in the background is not worth interrupting
      // anyone over; it will be tried again on the next thing said.
      console.warn('[grace] ambient transcription failed:', (cause as Error).message);
    } finally {
      setState((current) => (current === 'working' ? 'listening' : current));
    }
  }, []);

  considerRef.current = consider;

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setState('starting');

    let lease: MicLease;
    try {
      lease = await acquire(deviceId);
    } catch (cause) {
      runningRef.current = false;
      setState('off');
      setError(cause instanceof MicError ? cause.message : (cause as Error).message);
      return;
    }
    leaseRef.current = lease;

    const context = new AudioContext();
    contextRef.current = context;
    if (context.state === 'suspended') await context.resume();

    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.1;
    sourceRef.current = context.createMediaStreamSource(lease.stream);
    sourceRef.current.connect(analyser);

    const samples = new Uint8Array(analyser.fftSize);
    /*
     * Set by the first reading, not by the clock.
     *
     * Loading the worklet module takes a moment, and calibration used to start
     * counting the instant the microphone opened — so on a slow load the whole
     * calibration window elapsed before a single reading arrived, leaving the
     * measured room floor at zero. It then never recalibrated, because the
     * window had passed.
     */
    let openedAt = 0;
    let floor = 0;
    let floorSamples = 0;
    let speakingSince = 0;
    let quietSince = 0;
    /** Has any reading arrived at all? The watchdog below turns on this. */
    let heardSomething = false;
    /** True once the audio thread has been given up on. */
    let fromFrames = false;

    /*
     * The rolling buffer, and the reason the recorder is gone.
     *
     * Speech is only noticed once it is loud enough, and by then the first
     * syllable has already happened. A recorder started at that instant has
     * missed it — which for "Grace, put the lights on" means losing exactly the
     * word that decides whether she answers at all, and is most of why the same
     * sentence had to be said two or three times.
     *
     * So the last second and a half of audio is always in hand, and capture
     * begins from *before* the moment speech was detected. MediaRecorder cannot
     * do this: only its first chunk carries the stream header, so a buffer of
     * later chunks is undecodable on its own. Raw samples have no such problem,
     * and there is nothing to decode at the other end either.
     */
    const rate = context.sampleRate;
    const PREROLL = Math.round(rate * 0.5);
    const RING = Math.round(rate * 1.5);
    let ring: Float32Array[] = [];
    let ringLength = 0;
    let collected: Float32Array[] | null = null;

    const remember = (block: Float32Array) => {
      ring.push(block);
      ringLength += block.length;
      while (ringLength - ring[0].length >= RING) {
        ringLength -= (ring.shift() as Float32Array).length;
      }
    };

    const joined = (blocks: Float32Array[]): Float32Array => {
      const total = blocks.reduce((sum, block) => sum + block.length, 0);
      const out = new Float32Array(total);
      let at = 0;
      for (const block of blocks) {
        out.set(block, at);
        at += block.length;
      }
      return out;
    };

    /*
     * The fallback keeps a recorder, because it has no samples to keep.
     *
     * The frame clock only ever sees a loudness number; the raw audio arrives
     * with the worklet's readings and nowhere else. Without this, a fall back
     * to frames would leave her detecting speech perfectly and capturing
     * nothing at all — which is a worse failure than the one being fallen back
     * from, and completely silent.
     */
    let recorder: MediaRecorder | null = null;
    let chunks: BlobPart[] = [];

    const beginCapture = () => {
      if (fromFrames) {
        chunks = [];
        recorder = new MediaRecorder(lease.stream);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunks, {type: 'audio/webm'});
          if (blob.size > 0) void considerBlob(blob);
        };
        recorder.start();
        setState('hearing');
        return;
      }

      // Everything already in hand, trimmed to the pre-roll, so her name is
      // whole rather than starting halfway through the "G".
      const held = joined(ring);
      collected = [held.subarray(Math.max(0, held.length - PREROLL)).slice()];
      setState('hearing');
    };

    const endCapture = (keep: boolean) => {
      if (fromFrames) {
        const stopping = recorder;
        recorder = null;
        if (!stopping || stopping.state === 'inactive') return;
        if (!keep) stopping.onstop = null;
        stopping.stop();
        if (!keep) setState('listening');
        return;
      }

      const taken = collected;
      collected = null;
      if (!taken) return;
      if (keep) {
        const audio = joined(taken);
        if (audio.length > 0) void consider(audio, rate);
      } else {
        setState('listening');
      }
    };

    /**
     * One loudness reading, and everything that follows from it.
     *
     * Deliberately knows nothing about where the reading came from. That is
     * what lets the same judgement run from the audio thread, which never
     * stops, and from the frame clock, which does.
     */
    const onLevel = (rms: number, block?: Float32Array) => {
      if (!runningRef.current) return;

      heardSomething = true;
      if (block) {
        remember(block);
        if (collected) collected.push(block);
      }

      // Nobody is watching the meter on a tab nobody is looking at, and a
      // React render twenty times a second to move a bar that is not on screen
      // is the one part of this that genuinely wastes a laptop's battery.
      if (!document.hidden) setLevel(rms);

      const now = performance.now();
      if (openedAt === 0) {
        openedAt = now;
        floor = rms;
      }

      /*
       * The room's noise floor, tracked continuously rather than guessed once.
       *
       * It used to be an average of the first six hundred milliseconds, held
       * for the rest of the session. That is wrong in both directions: a car
       * passing during those six hundred milliseconds set a floor that then
       * needed shouting to clear, and a room that got quieter later never got
       * the benefit.
       *
       * Falls quickly and rises slowly, which is the right asymmetry — silence
       * is evidence about the room, and a loud moment is usually evidence about
       * a person. Only updated while nothing is being captured, so someone
       * talking cannot slowly convince her that talking is the background.
       */
      if (!collected) {
        floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.997 + rms * 0.003;
      }

      // Still worth a moment of settling before acting on anything: the first
      // readings after a microphone opens are frequently a click or a pop.
      if (now - openedAt < CALIBRATION_MS) {
        floorSamples += 1;
        return;
      }

      /*
       * While she is talking, she keeps listening — but only for her name.
       *
       * She used to go completely deaf whenever she spoke, which is why there
       * was no way to cut her off. Now the microphone stays live and anything
       * heard during her own speech is still transcribed; it simply has to
       * contain her name to count, so the sound of her own voice coming back
       * out of the speakers cannot start a conversation with itself.
       *
       * Thinking is different from speaking: while she is working on an answer
       * nothing is coming out of the speakers, so there is nothing to guard
       * against and no reason to hold the next thing you say.
       */
      if (pausedRef.current && !speakingRef.current) {
        if (collected) endCapture(false);
        return;
      }

      /*
       * How loud counts as talking.
       *
       * Set to be sensitive rather than safe, because the two failure modes are
       * not remotely equal. Too high and you have to raise your voice at a
       * machine in your own home, every time, and eventually stop bothering.
       * Too low and she occasionally transcribes a moment of nothing, finds no
       * name in it, and discards it — a fraction of a penny and no interruption
       * at all, because the wake word is what decides whether she answers.
       *
       * A little above the room rather than a multiple of it: at a genuinely
       * quiet floor a multiple is a tiny number, and at a noisy one it is
       * unreachable. The ceiling means no room, however loud, can leave her
       * needing to be shouted at.
       */
      const threshold = Math.min(0.03, Math.max(SPEECH_FLOOR, floor * 1.6 + 0.002));
      const loud = rms > threshold;

      if (loud) {
        quietSince = 0;
        if (!collected) {
          speakingSince = now;
          beginCapture();
        } else if (now - speakingSince > MAX_UTTERANCE_MS) {
          endCapture(true);
        }
      } else if (collected) {
        if (quietSince === 0) quietSince = now;
        else if (now - quietSince > TRAILING_SILENCE_MS) {
          const spoken = quietSince - speakingSince;
          endCapture(spoken > MIN_UTTERANCE_MS);
          quietSince = 0;
        }
      }

      if (awakeUntilRef.current > 0 && Date.now() > awakeUntilRef.current) {
        awakeUntilRef.current = 0;
        setAwake(false);
      }
    };

    /** The frame clock. Correct, and stops the moment you look away. */
    const watchOnScreen = () => {
      const tick = () => {
        if (!runningRef.current) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const value = sample / 128 - 1;
          sum += value * value;
        }
        onLevel(Math.sqrt(sum / samples.length));
        frameRef.current = window.requestAnimationFrame(tick);
      };
      tick();
    };

    /**
     * The audio thread. Runs whether or not this tab is the one you are on.
     *
     * The worklet has to reach the destination or nothing pulls audio through
     * it and process() is never called — so it goes through a gain of zero,
     * which keeps the graph alive and puts not one sample into the speakers.
     */
    try {
      await context.audioWorklet.addModule(EARS_URL);

      const ears = new AudioWorkletNode(context, 'grace-ears');
      earsRef.current = ears;
      ears.port.onmessage = (event: MessageEvent<{rms: number; audio: Float32Array}>) =>
        onLevel(event.data.rms, event.data.audio);

      const silent = context.createGain();
      silent.gain.value = 0;
      sourceRef.current.connect(ears);
      ears.connect(silent);
      silent.connect(context.destination);
      setEar('worklet');

      /*
       * The watchdog, and the reason this exists is worth writing down.
       *
       * A worklet can load without objecting and then never be called — a
       * suspended context, an autoplay policy that will not let the graph
       * start, a browser that quietly declines to pull a node whose output
       * goes nowhere audible. Every one of those throws nothing and reports
       * nothing. She simply never hears anything, for ever, and the interface
       * shows a microphone that is on.
       *
       * So: if no reading has arrived in a second and a half, stop believing
       * it and use the frame clock instead. Listening only while the tab is
       * visible is a poor outcome; listening never is a broken one.
       */
      window.setTimeout(() => {
        if (!runningRef.current || heardSomething) return;
        console.warn('[grace] the audio thread produced nothing; falling back');
        void context.resume().catch(() => {});
        fromFrames = true;
        setEar('frames');
        watchOnScreen();
      }, 1500);
    } catch (cause) {
      // Every browser worth naming has had AudioWorklet for years, but a
      // failure here would mean she cannot hear at all, and hearing you only
      // while you are looking at her is enormously better than that.
      console.warn(
        '[grace] audio worklet unavailable, listening only while visible:',
        (cause as Error).message,
      );
      fromFrames = true;
      setEar('frames');
      watchOnScreen();
    }
  }, [consider, considerBlob, deviceId]);

  useEffect(() => {
    if (enabled) void start();
    else stop();
    return () => {
      if (!enabled) return;
      stop();
    };
  }, [enabled, start, stop]);

  return {
    state,
    level,
    error,
    awake,
    heard,
    strangers,
    ear,
    lastScore,
    dormant,
    dropped,
    // Waking her from the interface, for when saying her name is not
    // convenient — or when she went to sleep and you changed your mind.
    // Sent to sleep from the interface or a typed command, not only by voice.
    sleep: useCallback(() => {
      dormantRef.current = true;
      setDormant(true);
      awakeUntilRef.current = 0;
      setAwake(false);
    }, []),
    rouse: useCallback(() => {
      dormantRef.current = false;
      setDormant(false);
    }, []),
  };
}
