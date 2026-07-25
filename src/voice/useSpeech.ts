import {useCallback, useEffect, useRef, useState} from 'react';

/** Rough preference order for a calm, British-leaning female voice. */
function scoreVoice(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  let score = 0;

  if (voice.lang.startsWith('en-GB')) score += 40;
  else if (voice.lang.startsWith('en')) score += 20;
  else return -1;

  if (/female|serena|kate|sonia|libby|amelie|fiona|samantha|karen|moira/.test(name)) {
    score += 30;
  }
  if (/male|daniel|arthur|oliver|george|fred|alex/.test(name)) score -= 30;
  // Cloud voices are markedly less robotic than the bundled ones.
  if (/google|natural|premium|enhanced/.test(name)) score += 15;

  return score;
}

const SENTENCE_END = /(?<=[.!?…])\s+|(?<=[.!?…])$/;

/**
 * Speaks Grace's reply as it streams in, one sentence at a time, so she starts
 * talking while the rest is still arriving.
 */
export function useSpeech(enabled: boolean) {
  const [speaking, setSpeaking] = useState(false);
  const [supported] = useState(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
  );

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const bufferRef = useRef('');
  const pendingRef = useRef(0);

  useEffect(() => {
    if (!supported) return;

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;
      const best = [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0];
      if (scoreVoice(best) > 0) voiceRef.current = best;
    };

    pickVoice();
    window.speechSynthesis.addEventListener('voiceschanged', pickVoice);
    return () =>
      window.speechSynthesis.removeEventListener('voiceschanged', pickVoice);
  }, [supported]);

  // Chrome stops long synthesis runs unless it is nudged periodically.
  useEffect(() => {
    if (!speaking || !supported) return;
    const keepAlive = window.setInterval(() => window.speechSynthesis.resume(), 8000);
    return () => window.clearInterval(keepAlive);
  }, [speaking, supported]);

  const utter = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;

      const utterance = new SpeechSynthesisUtterance(clean);
      if (voiceRef.current) utterance.voice = voiceRef.current;
      utterance.lang = voiceRef.current?.lang ?? 'en-GB';
      // Measured and even, rather than the default clip.
      utterance.rate = 1.02;
      utterance.pitch = 1.0;

      pendingRef.current += 1;
      setSpeaking(true);

      const finish = () => {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (pendingRef.current === 0) setSpeaking(false);
      };
      utterance.onend = finish;
      utterance.onerror = finish;

      window.speechSynthesis.speak(utterance);
    },
    [],
  );

  /** Feed streamed text in; complete sentences are spoken as they appear. */
  const push = useCallback(
    (delta: string) => {
      if (!enabled || !supported) return;

      bufferRef.current += delta;
      const parts = bufferRef.current.split(SENTENCE_END);
      // The trailing fragment may still be mid-sentence, so it stays buffered.
      bufferRef.current = parts.pop() ?? '';
      parts.forEach(utter);
    },
    [enabled, supported, utter],
  );

  /** Speak whatever is left once the stream ends. */
  const flush = useCallback(() => {
    if (!enabled || !supported) return;
    const remainder = bufferRef.current;
    bufferRef.current = '';
    utter(remainder);
  }, [enabled, supported, utter]);

  const cancel = useCallback(() => {
    if (!supported) return;
    bufferRef.current = '';
    pendingRef.current = 0;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  useEffect(() => cancel, [cancel]);

  return {speaking, supported, push, flush, cancel};
}
