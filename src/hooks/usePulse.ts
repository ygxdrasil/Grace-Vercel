import {useCallback, useEffect, useRef, useState} from 'react';
import type {Concern, Message} from '../../shared/types.ts';
import * as api from '../lib/api.ts';

/**
 * Grace looking around while nobody is talking to her.
 *
 * The laptop in the corner of the room is the thing that makes this possible:
 * a page that is always open is a heartbeat, and a heartbeat is the difference
 * between an assistant who answers and one who tells you something.
 *
 * Three things keep it from becoming a nuisance. It waits for a quiet moment —
 * never while she is mid-sentence or the microphone is live. It skips entirely
 * while the tab is hidden, since a machine nobody is near is a machine nobody
 * should be spoken to from. And the server refuses to raise anything twice, so
 * the worst case here is a wasted round trip rather than a repeated remark.
 */

/**
 * Every two minutes. It was hourly; the user asked for her to check
 * constantly. A look with nothing new costs no model call at all, and the
 * server's own loop stands back while this page is the one looking.
 */
const EVERY_MS = 2 * 60 * 1000;

/**
 * Nothing at all for the first stretch after opening.
 *
 * Longer than it looks like it needs to be: opening her should not be
 * immediately followed by her interrupting you.
 */
const SETTLE_MS = 90 * 1000;

interface Options {
  enabled: boolean;
  /** True while she is talking, listening or thinking — never interrupt that. */
  busy: boolean;
  /** Says the line aloud. */
  onSpeak: (text: string) => void;
  /** Puts her remark in the transcript. */
  onSaid: (message: Message) => void;
}

export function usePulse({enabled, busy, onSpeak, onSaid}: Options) {
  const [concerns, setConcerns] = useState<Concern[]>([]);
  const [held, setHeld] = useState<string | null>(null);
  const [lastLookedAt, setLastLookedAt] = useState<number | null>(null);

  // Held in refs so the interval is created once and never torn down by a
  // changing callback — a re-created interval that never fires is the classic
  // way this kind of loop silently stops working.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const speakRef = useRef(onSpeak);
  speakRef.current = onSpeak;
  const saidRef = useRef(onSaid);
  saidRef.current = onSaid;
  const runningRef = useRef(false);

  const look = useCallback(async () => {
    if (runningRef.current || busyRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    runningRef.current = true;
    try {
      const result = await api.pulse();
      setLastLookedAt(Date.now());
      setHeld(result.held);
      if (result.concerns.length > 0) {
        setConcerns((current) => [...result.concerns, ...current].slice(0, 12));
      }
      if (result.message) saidRef.current(result.message);
      if (result.say) speakRef.current(result.say);
    } catch {
      // A failed look is not worth telling anyone about. The next one is four
      // minutes away and the state it reads is server-side either way.
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const settle = setTimeout(() => void look(), SETTLE_MS);
    const timer = setInterval(() => void look(), EVERY_MS);
    return () => {
      clearTimeout(settle);
      clearInterval(timer);
    };
  }, [enabled, look]);

  return {concerns, held, lastLookedAt, lookNow: look};
}
