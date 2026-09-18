import {useCallback, useEffect, useRef, useState} from 'react';
import {acquire, MicError, type MicLease} from './mic';
import {toWav, type EncodedAudio} from './wav';

/** Anything shorter than this is a mis-tap rather than a sentence. */
const MIN_SECONDS = 0.3;

/** Stop on our own terms rather than uploading a recording of an empty room. */
const MAX_SECONDS = 60;

/**
 * Floor for the speech threshold, as RMS of the normalised waveform.
 *
 * One per cent of full scale is the figure the web audio community has
 * settled on for "definitely not silence". The live threshold is whichever is
 * higher, this or a multiple of the measured room tone.
 */
const SPEECH_LEVEL = 0.01;

/** Time spent measuring the room before any of it counts as speech. */
const CALIBRATION_MS = 350;

/**
 * Silence this long after speech means the sentence is finished.
 *
 * Every millisecond here is dead air the user sits through before anything
 * starts happening, so it is as short as it can be without cutting people off
 * mid-thought. Below about seven hundred it starts clipping the natural pause
 * in front of a second clause.
 */
const TRAILING_SILENCE_MS = 850;

/** How long to wait for someone to start before giving up. */
const OPENING_PATIENCE_MS = 9000;

/** Below this much speech, a pause is hesitation rather than the end. */
const MIN_SPEECH_MS = 700;

/** No audio data at all by now means the capture is not really running. */
const WATCHDOG_MS = 2800;

/**
 * How long a start may be in progress before a fresh press overrules it.
 *
 * Comfortably past the microphone's own patience for an unanswered permission
 * prompt, so this only ever fires for something that has genuinely hung.
 */
const STUCK_AFTER_MS = 20_000;

export type RecorderState = 'idle' | 'starting' | 'recording' | 'working';

interface RecorderOptions {
  onCaptured: (audio: EncodedAudio) => void;
  /** Which microphone to use. Undefined means whichever the system prefers. */
  deviceId?: string;
}

/**
 * Records from the microphone and hands back WAV audio.
 *
 * Built on getUserMedia and MediaRecorder, which exist in every current
 * browser — unlike speech recognition, which does not exist in Firefox or on
 * iOS at all. The level meter matters as much as the recording: it is the
 * difference between "she can't hear me" and knowing whether the microphone is
 * picking up sound in the first place.
 */
export function useRecorder({onCaptured, deviceId}: RecorderOptions) {
  const [state, setState] = useState<RecorderState>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * Why the device itself could not be opened, when that is what failed.
   *
   * Told apart from `error` because the two are acted on differently. A clip
   * that was too short, or a room that stayed quiet, is worth saying and worth
   * trying again. A microphone that is blocked, absent, or unsupported will
   * not become any of those things by being asked a second time.
   */
  const [fault, setFault] = useState<MicError['kind'] | null>(null);
  const [heardSomething, setHeardSomething] = useState(false);

  const leaseRef = useRef<MicLease | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const contextRef = useRef<AudioContext | null>(null);
  /**
   * Held deliberately. A MediaStreamAudioSourceNode kept only in a local
   * variable can be garbage collected, after which the analyser goes silently
   * dead and every reading is zero — indistinguishable from a dead microphone.
   */
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const watchdogRef = useRef<number | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const stopTimerRef = useRef<number | undefined>(undefined);
  const onCapturedRef = useRef(onCaptured);
  const stopRef = useRef<() => void>(() => {});
  const spokeRef = useRef(false);
  /** True from the moment start() is called until the recorder is idle again. */
  const busyRef = useRef(false);
  /** When it was set, so a guard that is never cleared cannot be permanent. */
  const busySinceRef = useRef(0);
  /** Set when the watchdog fired, so its diagnosis is not written over. */
  const starvedRef = useRef(false);

  /** The only way back to idle, so the re-entrancy guard cannot be stranded. */
  const becomeIdle = useCallback(() => {
    busyRef.current = false;
    busySinceRef.current = 0;
    setState('idle');
  }, []);

  useEffect(() => {
    onCapturedRef.current = onCaptured;
  }, [onCaptured]);

  const supported =
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';

  const teardown = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current ?? 0);
    window.clearTimeout(stopTimerRef.current);
    window.clearTimeout(watchdogRef.current);
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    recorderRef.current = null;
    leaseRef.current?.release();
    leaseRef.current = null;
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      teardown();
      becomeIdle();
    }
  }, [teardown]);

  stopRef.current = stop;

  const start = useCallback(async () => {
    // Re-entrancy guard. Opening the microphone takes as long as the
    // permission prompt stays up, and a second press in that window used to
    // overwrite the lease, the audio context and the animation frame — leaving
    // the first stream open for the rest of the session with the browser's
    // recording light on and a level meter running forever.
    //
    // It is a guard and not a latch. Whatever it is waiting on can fail to
    // come back — a permission prompt that is never answered, a promise that
    // neither resolves nor rejects — and a guard that is never cleared is a
    // button that is dead for the rest of the session, saying nothing. Past
    // the point where any honest start could still be in progress, the press
    // wins.
    if (busyRef.current) {
      const stuckFor = performance.now() - busySinceRef.current;
      if (stuckFor < STUCK_AFTER_MS) return;
      teardown();
    }
    busyRef.current = true;
    busySinceRef.current = performance.now();

    setError(null);
    setFault(null);
    setHeardSomething(false);
    spokeRef.current = false;
    setState('starting');

    let lease: MicLease;
    try {
      lease = await acquire(deviceId);
    } catch (cause) {
      becomeIdle();
      setFault(cause instanceof MicError ? cause.kind : 'unknown');
      setError(
        cause instanceof MicError
          ? cause.message
          : `The microphone could not start: ${(cause as Error).message}`,
      );
      return;
    }

    leaseRef.current = lease;
    const {stream} = lease;

    // A track that arrives already muted or ended is the classic silent
    // failure: permission was granted, but nothing is coming through. Chrome
    // is the one browser that reports this honestly, so it is worth asking.
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      teardown();
      becomeIdle();
      setError('The microphone opened but immediately closed. Try reloading the page.');
      return;
    }
    if (track.muted) {
      teardown();
      becomeIdle();
      setError(
        `“${track.label || 'That microphone'}” is muted at the system level. Check the ` +
          'mute key or switch, and that it is not muted in your sound settings.',
      );
      return;
    }

    // Live level, so silence can be told apart from a dead microphone.
    try {
      const context = new AudioContext();
      contextRef.current = context;
      // Chrome can hand back a suspended context; an analyser on a suspended
      // context reads nothing but zeroes, which looks exactly like silence.
      if (context.state === 'suspended') await context.resume();

      const analyser = context.createAnalyser();
      // Larger window than a spectral read needs, because this is a
      // time-domain RMS measurement and short windows are jumpy.
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.1;
      sourceRef.current = context.createMediaStreamSource(stream);
      sourceRef.current.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      const openedAt = performance.now();
      let spokeAt = 0;
      let spokeSince = 0;
      /**
       * The room, measured rather than assumed. A fixed threshold is wrong on
       * a high-gain USB microphone and wrong again on a laptop array with
       * automatic gain, so the first moments set the floor.
       */
      let floor = 0;
      let floorSamples = 0;

      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const value = sample / 128 - 1;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / samples.length);
        setLevel(rms);

        const now = performance.now();
        const elapsed = now - openedAt;

        if (elapsed < CALIBRATION_MS) {
          floor = (floor * floorSamples + rms) / (floorSamples + 1);
          floorSamples += 1;
          frameRef.current = window.requestAnimationFrame(tick);
          return;
        }

        const threshold = Math.max(SPEECH_LEVEL, floor * 2.5);
        if (rms > threshold) {
          setHeardSomething(true);
          spokeRef.current = true;
          if (spokeSince === 0) spokeSince = now;
          spokeAt = now;
        }

        // She closes the recording herself once you stop talking. Requiring a
        // second press is the single easiest thing to get wrong, and getting
        // it wrong looks exactly like an assistant who cannot hear you.
        // A pause after half a word is someone thinking, not someone finished.
        // Without this, "Grace —" followed by a breath ends the recording and
        // the rest of the sentence is simply lost.
        const settled = spokeSince > 0 && now - spokeSince > MIN_SPEECH_MS;
        if (settled && spokeAt > 0 && now - spokeAt > TRAILING_SILENCE_MS) {
          stopRef.current();
          return;
        }
        if (spokeAt === 0 && elapsed > OPENING_PATIENCE_MS) {
          stopRef.current();
          return;
        }

        frameRef.current = window.requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Metering is a nicety; recording still works without it.
    }

    // Never hard-code a container. audio/mp4 support depends on the machine
    // having a platform encoder, so the same code can succeed on one Windows
    // laptop and throw NotSupportedError on the next.
    let recorder: MediaRecorder;
    try {
      const format = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/ogg;codecs=opus',
      ].find((type) => MediaRecorder.isTypeSupported?.(type));
      recorder = new MediaRecorder(stream, format ? {mimeType: format} : undefined);
    } catch (cause) {
      teardown();
      becomeIdle();
      setError(`This browser refused to start a recording: ${(cause as Error).message}`);
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
        // Data is arriving, so the capture is genuinely alive.
        window.clearTimeout(watchdogRef.current);
      }
    };

    // The UI follows the recorder, not the click. A recorder that never
    // actually starts should never look as though it did.
    recorder.onstart = () => setState('recording');

    recorder.onerror = () => {
      setError('The recording stopped unexpectedly.');
      teardown();
      becomeIdle();
    };

    recorder.onstop = async () => {
      const recording = new Blob(chunksRef.current, {
        type: recorder.mimeType || 'audio/webm',
      });
      const spoke = spokeRef.current;
      teardown();

      if (recording.size === 0) {
        // Leave the watchdog's message alone if it already fired: "a virtual
        // device with nothing routed into it" is a diagnosis, and this is not.
        if (!starvedRef.current) {
          setError('Nothing was recorded at all. Reload the page and try again.');
        }
        becomeIdle();
        return;
      }

      // Never send an empty room off to be transcribed: it costs a request and
      // comes back with nothing, which reads as her failing to understand you
      // rather than never having heard you.
      if (!spoke) {
        setError(
          'No sound reached me. Open Sound check and confirm the right microphone ' +
            'is selected — the level bar should move while you talk.',
        );
        becomeIdle();
        return;
      }

      setState('working');
      try {
        const audio = await toWav(recording);
        if (audio.seconds < MIN_SECONDS) {
          setError('That was too short to make out. Hold it a little longer.');
          becomeIdle();
          return;
        }
        onCapturedRef.current(audio);
      } catch (cause) {
        setError(`The recording could not be prepared: ${(cause as Error).message}`);
      } finally {
        becomeIdle();
      }
    };

    // A one-second timeslice doubles as a heartbeat. Without it the only data
    // event arrives at stop(), so a capture that is producing nothing looks
    // identical to one that is working right up until the moment it fails.
    try {
      recorder.start(1000);
    } catch (cause) {
      teardown();
      becomeIdle();
      setError(`This browser refused to record: ${(cause as Error).message}`);
      return;
    }
    setState('recording');

    starvedRef.current = false;
    watchdogRef.current = window.setTimeout(() => {
      if (recorderRef.current !== recorder) return;
      starvedRef.current = true;
      setError(
        'The microphone opened but sent no audio at all. This usually means the ' +
          'selected input is a virtual device with nothing routed into it. Open ' +
          'Sound check and pick a different microphone.',
      );
      stopRef.current();
    }, WATCHDOG_MS);

    stopTimerRef.current = window.setTimeout(() => stopRef.current(), MAX_SECONDS * 1000);
  }, [deviceId, teardown]);

  useEffect(() => teardown, [teardown]);

  return {supported, state, level, error, fault, heardSomething, start, stop};
}
