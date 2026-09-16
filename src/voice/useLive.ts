import {useCallback, useEffect, useRef, useState} from 'react';
import {voiceKey, type VoiceKey} from '../lib/api';
import {acquire, type MicLease} from './mic';
import {LiveVoice, type LiveState} from './live';

/**
 * Holding a conversation, and — just as importantly — letting go of one.
 *
 * A live session is billed for every minute it is open, whether or not anyone
 * is talking into it. That single fact decides the shape of this hook.
 *
 * It is why the session is not simply opened when the page loads and left
 * running: that would be about $216 a month to sit in an empty room listening
 * to silence, which is most of a year's credit spent on nothing. The wake word
 * stays where it is — in the browser, costing nothing, hearing only her name —
 * and this opens a session when she is actually spoken to.
 *
 * It is also why the idle timer below is not a nicety. A session nobody closes
 * is a meter running in an empty room, and the way that would be discovered is
 * the bill.
 */

/**
 * How long she stays on the line after the last thing anyone said.
 *
 * Long enough that a pause for thought, or going to fetch something, does not
 * hang up on you — having to say her name again mid-task is the thing that
 * makes an assistant feel like a vending machine. Short enough that walking
 * out of the room costs pennies rather than pounds.
 */
const HANGS_UP_AFTER_MS = 45_000;

export interface LiveVoiceControls {
  /** False when no outpost is configured; the caller falls back to recording. */
  available: boolean;
  state: LiveState;
  /** What she is currently reaching for, if anything. */
  doing: string | null;
  trouble: string | null;
  /** Start talking. Safe to call when already talking. */
  begin: () => Promise<void>;
  /** Stop, and stop the meter. */
  end: () => void;
  /** Typed rather than spoken, when the microphone is refused or you are not alone. */
  say: (text: string) => void;
}

interface LiveOptions {
  deviceId?: string;
  /** What you said, as she heard it — so the transcript shows both halves. */
  onHeard?: (text: string) => void;
  onSaid?: (text: string) => void;
}

export function useLive({deviceId, onHeard, onSaid}: LiveOptions = {}): LiveVoiceControls {
  const [key, setKey] = useState<VoiceKey | null>(null);
  const [state, setState] = useState<LiveState>('closed');
  const [doing, setDoing] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  const voiceRef = useRef<LiveVoice | null>(null);
  const leaseRef = useRef<MicLease | null>(null);
  const idleRef = useRef<number | undefined>(undefined);
  const openingRef = useRef(false);
  const heardRef = useRef(onHeard);
  const saidRef = useRef(onSaid);

  useEffect(() => {
    heardRef.current = onHeard;
    saidRef.current = onSaid;
  });

  useEffect(() => {
    void voiceKey().then(setKey);
  }, []);

  const end = useCallback(() => {
    window.clearTimeout(idleRef.current);
    idleRef.current = undefined;
    voiceRef.current?.close();
    voiceRef.current = null;
    // Released rather than stopped: the wake word is holding the same device
    // and must keep hearing. Stopping the track would leave her deaf until
    // the page was reloaded, with nothing on screen to explain why.
    leaseRef.current?.release();
    leaseRef.current = null;
    setState('closed');
    setDoing(null);
  }, []);

  /** Any sign of life postpones hanging up. */
  const stayAwhile = useCallback(() => {
    window.clearTimeout(idleRef.current);
    idleRef.current = window.setTimeout(end, HANGS_UP_AFTER_MS);
  }, [end]);

  const begin = useCallback(async () => {
    if (!key?.live || !key.token) return;
    // Already talking, or halfway through starting. Saying her name twice in
    // quick succession must not open two sessions and bill for both.
    if (voiceRef.current || openingRef.current) {
      stayAwhile();
      return;
    }

    openingRef.current = true;
    setTrouble(null);

    try {
      const lease = await acquire(deviceId);
      leaseRef.current = lease;

      const voice = new LiveVoice({
        onState: (next) => {
          setState(next);
          stayAwhile();
        },
        onHeard: (text) => {
          heardRef.current?.(text);
          stayAwhile();
        },
        onSaid: (text) => {
          saidRef.current?.(text);
          stayAwhile();
        },
        onDoing: (name) => {
          setDoing(name);
          stayAwhile();
        },
        onTrouble: (detail) => {
          setTrouble(detail);
          // Not left half-open. A session that has failed still costs money
          // for as long as it is open, and a broken one will not close itself.
          end();
        },
      });

      await voice.open(key.url, key.token, lease.stream);
      voiceRef.current = voice;
      stayAwhile();
    } catch (error) {
      setTrouble((error as Error).message);
      leaseRef.current?.release();
      leaseRef.current = null;
    } finally {
      openingRef.current = false;
    }
  }, [deviceId, end, key, stayAwhile]);

  /*
   * Closing the tab, navigating away, or the laptop going to sleep must all
   * end the session. The browser does not do this for us — the socket dies
   * eventually, but "eventually" is billed by the minute.
   */
  useEffect(() => {
    const leave = () => end();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      end();
    };
  }, [end]);

  return {
    available: Boolean(key?.live),
    state,
    doing,
    trouble,
    begin,
    end,
    say: (text) => voiceRef.current?.say(text),
  };
}
