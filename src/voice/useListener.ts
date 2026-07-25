import {useCallback, useEffect, useRef, useState} from 'react';

/** "Grace", plus whatever punctuation the transcriber tacks on after it. */
const WAKE_WORD = /\bgrace\b[\s,.:;!?-]*/i;

/** Give up on a request that never arrives after the wake word. */
const CAPTURE_TIMEOUT = 12_000;

interface ListenerOptions {
  /** Master microphone switch — must be turned on by a user gesture. */
  enabled: boolean;
  /** Temporarily deaf, so Grace doesn't transcribe her own voice. */
  paused: boolean;
  onRequest: (text: string) => void;
}

/**
 * Continuous listening with wake-word activation.
 *
 * Sits in a low-attention state until it hears "Grace", then captures the next
 * utterance as a request. Saying "Grace, what's on today" in one breath is
 * understood as a single request rather than two.
 */
export function useListener({enabled, paused, onRequest}: ListenerOptions) {
  const [supported] = useState(
    () =>
      typeof window !== 'undefined' &&
      Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition),
  );
  const [awake, setAwake] = useState(false);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldRunRef = useRef(false);
  const awakeRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const onRequestRef = useRef(onRequest);

  useEffect(() => {
    onRequestRef.current = onRequest;
  }, [onRequest]);

  const sleep = useCallback(() => {
    awakeRef.current = false;
    setAwake(false);
    window.clearTimeout(timerRef.current);
  }, []);

  const wake = useCallback(() => {
    awakeRef.current = true;
    setAwake(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(sleep, CAPTURE_TIMEOUT);
  }, [sleep]);

  const handleFinal = useCallback(
    (text: string) => {
      const spoken = text.trim();
      if (!spoken) return;

      if (awakeRef.current) {
        sleep();
        onRequestRef.current(spoken);
        return;
      }

      const match = WAKE_WORD.exec(spoken);
      if (!match) return;

      const rest = spoken.slice(match.index + match[0].length).trim();
      const words = rest.split(/\s+/).filter(Boolean);

      // Enough words to be a request on its own; anything shorter is treated as
      // just getting her attention.
      if (words.length >= 2) {
        sleep();
        onRequestRef.current(rest);
      } else {
        wake();
      }
    },
    [sleep, wake],
  );

  useEffect(() => {
    if (!supported) return;

    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const recognition = new Recognition!();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-GB';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) handleFinal(transcript);
        else interim += transcript;
      }
      setHeard(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        shouldRunRef.current = false;
        setError('Microphone access was refused.');
        return;
      }
      setError(event.error);
    };

    // Browsers stop recognition on their own schedule; pick it straight back up.
    recognition.onend = () => {
      setHeard('');
      if (!shouldRunRef.current) return;
      try {
        recognition.start();
      } catch {
        // Already restarting — harmless.
      }
    };

    recognitionRef.current = recognition;

    return () => {
      shouldRunRef.current = false;
      recognition.onend = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, [supported, handleFinal]);

  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    const shouldRun = enabled && !paused;
    shouldRunRef.current = shouldRun;

    if (shouldRun) {
      setError(null);
      try {
        recognition.start();
      } catch {
        // start() throws if it is already running, which is fine.
      }
    } else {
      sleep();
      recognition.stop();
    }
  }, [enabled, paused, sleep]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return {supported, awake, heard, error, wake, sleep};
}
