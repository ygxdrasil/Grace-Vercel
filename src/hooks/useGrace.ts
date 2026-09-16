import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
  AttentionMode,
  Choice,
  GoogleStatus,
  GraceState,
  InputMode,
  Message,
  Profile,
  ProfileEntry,
} from '../../shared/types.ts';
import * as api from '../lib/api.ts';
import {chimeAct, chimeDone, chimeWake} from '../lib/chime.ts';
import {NeedsPassword, type SessionStatus} from '../lib/api.ts';
import {usePulse} from './usePulse.ts';
import {useAmbient} from '../voice/useAmbient.ts';
import {useLive} from '../voice/useLive.ts';
import {COMMANDS, parseCommand, type Parsed} from '../../shared/commands.ts';

export type VoiceMode = 'all' | 'answers' | 'off';
import type {GuardState} from '../voice/voiceprint.ts';
import {useRecorder} from '../voice/useRecorder.ts';
import {useSpeech} from '../voice/useSpeech.ts';
import {useWakeLock} from '../voice/useWakeLock.ts';
import type {EncodedAudio} from '../voice/wav.ts';

export type Mode = 'offline' | 'idle' | 'waiting' | 'listening' | 'thinking' | 'speaking';

export function useGrace() {
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [state, setState] = useState<GraceState | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  /** She consulted the web for the reply currently arriving. */
  const [searched, setSearched] = useState(false);
  /** What she actually did while answering, so no action is invisible. */
  const [actions, setActions] = useState<string[]>([]);
  /** A question she has put to you, waiting on a tap. */
  const [asked, setAsked] = useState<{question: string; choices: Choice[]} | null>(null);
  /**
   * Pages she has asked the browser to open, and the room to move to.
   *
   * Held as state with a stamp rather than fired straight into a callback:
   * this hook has no business opening windows, and the stamp is what lets the
   * same instruction twice in a row still register as two events.
   */
  const [opening, setOpening] = useState<{
    urls: string[];
    workspace?: string;
    at: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  /**
   * How much she says out loud, kept per device.
   *
   * Three settings rather than a switch, because the useful one is in the
   * middle. On a phone, "change the light to red" wants the light changed and
   * nothing else — being told what you just asked for is noise, and on a phone
   * in company it is worse than noise. But "what is on today" is a question,
   * and an answer you cannot hear is not an answer.
   *
   * So: everything, answers only, or nothing.
   */
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(() => {
    const saved = localStorage.getItem('grace-voice-mode');
    if (saved === 'all' || saved === 'answers' || saved === 'off') return saved;
    return 'all';
  });
  useEffect(() => {
    localStorage.setItem('grace-voice-mode', voiceMode);
  }, [voiceMode]);
  const voiceOn = voiceMode !== 'off';
  const setVoiceOn = useCallback((on: boolean) => setVoiceMode(on ? 'all' : 'off'), []);

  const abortRef = useRef<AbortController | null>(null);
  /** Set once ambient listening exists, so /sleep can reach it. */
  const ambientRef = useRef<(() => void) | null>(null);
  const handleRecordingRef = useRef<(audio: EncodedAudio) => void>(() => {});
  const speech = useSpeech(voiceOn);

  // Browsers hand out permission to play audio on the first real gesture and
  // not before. Taking it from any click at all means she is never mute merely
  // because the first thing you did was press the wrong button.
  const {unlock} = speech;
  useEffect(() => {
    const take = () => unlock();
    window.addEventListener('pointerdown', take);
    window.addEventListener('keydown', take);
    return () => {
      window.removeEventListener('pointerdown', take);
      window.removeEventListener('keydown', take);
    };
  }, [unlock]);

  const load = useCallback(async () => {
    const loaded = await api.fetchState();
    setState(loaded);
    setMessages(loaded.messages);
  }, []);

  useEffect(() => {
    api
      .fetchSession()
      .then(async (status) => {
        setSession(status);
        if (status !== 'ok' && status !== 'open') return;
        await load();

        // She says something when you walk in, at most once every few hours.
        // Not spoken: opening her is not the same as talking to her, and a
        // voice starting up unbidden in a quiet room is startling.
        const hello = await api
          .greeting()
          .catch(() => ({say: null, message: undefined}));
        if (hello.message) {
          const said = hello.message;
          setMessages((current) => [...current, said]);
        }
      })
      .catch((cause: Error) => setError(cause.message));
  }, [load]);

  const signIn = useCallback(
    async (password: string) => {
      await api.login(password);
      setSession('ok');
      setError(null);
      await load();
    },
    [load],
  );

  const signOut = useCallback(async () => {
    await api.logout();
    setSession('required');
    setState(null);
    setMessages([]);
  }, []);

  const addLearned = useCallback((entries: ProfileEntry[]) => {
    if (entries.length === 0) return;
    setState((current) =>
      current
        ? {
            ...current,
            profile: {
              ...current.profile,
              entries: [...current.profile.entries, ...entries],
            },
          }
        : current,
    );
  }, []);

  /**
   * A typed command, carried out here rather than said to her.
   *
   * Deliberately not routed through the model. These are instructions to the
   * machinery — a model that might decline, or reword, or decide to ask first,
   * is exactly wrong for "clear this" and "fold that up". They appear in the
   * transcript as her reporting what happened, which is the part that should
   * read like a conversation.
   */
  const runCommand = useCallback(
    async ({name, rest}: Parsed) => {
      const say = (spoken: string) =>
        setMessages((current) => [
          ...current,
          {
            id: `command-${Date.now()}`,
            speaker: 'grace' as const,
            text: spoken,
            at: new Date().toISOString(),
            via: 'text' as const,
          },
        ]);

      setMessages((current) => [
        ...current,
        {
          id: `you-${Date.now()}`,
          speaker: 'user' as const,
          text: `/${name}${rest ? ` ${rest}` : ''}`,
          at: new Date().toISOString(),
          via: 'text' as const,
        },
      ]);

      if (name === 'help') {
        say(
          COMMANDS.map((one) => `/${one.name}${one.takes ? ` ${one.takes}` : ''} — ${one.blurb}`).join(
            '\n',
          ),
        );
        return;
      }

      if (name === 'sleep') {
        ambientRef.current?.();
        say('Asleep. Say my name and I’m back.');
        return;
      }

      if (name === 'clear') {
        await api.clearConversation().catch(() => {});
        setMessages([]);
        return;
      }

      setBusy(true);
      try {
        if (name === 'compact') {
          const {folded, summary} = await api.compactNow();
          say(
            folded
              ? `Folded. What I'm carrying forward:\n\n${summary ?? ''}`
              : 'Nothing to fold — this conversation is already short.',
          );
          await load().catch(() => {});
          return;
        }

        if (name === 'research') {
          if (!rest) {
            say('Give me something to look into — /research followed by the question.');
            return;
          }
          const found = await api.deepResearch(rest);
          say(
            `${found.report}\n\n(Looked up: ${found.strands.join('; ')}. Kept as “${found.title}” in Files.)`,
          );
          return;
        }
      } catch (cause) {
        if (cause instanceof NeedsPassword) setSession('required');
        else say(`That didn't work: ${(cause as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const send = useCallback(
    async (text: string, via: InputMode) => {
      const spoken = text.trim();
      if (!spoken || abortRef.current) return;

      // Typed commands never reach her, and never reach the model.
      const command = via === 'text' ? parseCommand(spoken) : null;
      if (command) {
        void runCommand(command);
        return;
      }

      setError(null);
      setBusy(true);
      setStreaming('');
      setSearched(false);
      setActions([]);
      setAsked(null);
      speech.cancel();

      setMessages((current) => [
        ...current,
        {
          id: `local-${Date.now()}`,
          speaker: 'user',
          text: spoken,
          at: new Date().toISOString(),
          via,
        },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      // She answers the way she was addressed. Speak to her and she speaks
      // back; type and she stays quiet. On a phone in public that is the
      // difference between an assistant and an embarrassment, and it is what
      // a person would do.
      const speakIt = voiceOn && via === 'voice';
      speech.unlock();
      let landed = false;

      /*
       * "Answers only", and how it can be decided before she has finished.
       *
       * A tool call happens in a round before the words do, so by the time the
       * first fragment of text arrives it is already known whether she went and
       * did something. If she did, nothing is spoken as it streams — and at the
       * end, a reply long enough to be an actual answer is spoken whole while a
       * short one is left as the light going red and nothing else.
       *
       * The length test is what keeps it honest: "put the lights on and tell me
       * what's in my diary" does both, and the diary half deserves saying out
       * loud.
       */
      let acted = false;
      const holding = () => speakIt && voiceMode === 'answers' && acted;

      try {
        for await (const event of api.streamChat(spoken, via, controller.signal)) {
          if (event.type === 'delta') {
            setStreaming((current) => current + event.text);
            if (speakIt && !holding()) speech.push(event.text);
          } else if (event.type === 'done') {
            if (speakIt && !holding()) speech.flush();
            else if (holding() && event.message.text.trim().split(/\s+/).length > 14) {
              speech.say(event.message.text);
            }
            const {message} = event;
            setStreaming('');
            setMessages((current) => [...current, message]);
            chimeDone();
            landed = true;
          } else if (event.type === 'searched') {
            setSearched(true);
          } else if (event.type === 'open') {
            setOpening({urls: event.urls, workspace: event.workspace, at: Date.now()});
          } else if (event.type === 'asked') {
            setAsked({question: event.question, choices: event.choices});
          } else if (event.type === 'acted') {
            acted = true;
            chimeAct();
            setActions((current) => [...current, event.summary]);
          } else if (event.type === 'search-failed') {
            setError(`I couldn’t reach the web for that: ${event.reason}`);
          } else if (event.type === 'learned') {
            addLearned(event.entries);
          } else if (event.type === 'error') {
            setError(event.message);
            setStreaming('');
          }
        }
      } catch (cause) {
        if (cause instanceof NeedsPassword) setSession('required');
        else if ((cause as Error).name !== 'AbortError') {
          setError((cause as Error).message);
        }
        setStreaming('');
      } finally {
        abortRef.current = null;
        setBusy(false);
      }

      // Learning and compaction happen after the reply, as their own request,
      // so neither delays what she says.
      if (landed) {
        api.reflect().then(addLearned).catch(() => {});
      }
    },
    [addLearned, runCommand, speech, voiceOn, voiceMode],
  );

  const handleRequest = useCallback(
    (text: string) => {
      void send(text, 'voice');
    },
    [send],
  );

  const [transcribing, setTranscribing] = useState(false);
  const [misheard, setMisheard] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);

  const recorder = useRecorder({
    deviceId,
    onCaptured: (audio) => void handleRecordingRef.current(audio),
  });

  /**
   * Whether someone is mid-sentence in the room.
   *
   * A ref rather than the value itself: the pulse is a long-lived loop, and
   * threading a state value through it would rebuild the timer on every word
   * anyone says near the microphone.
   */
  const ambientAwakeRef = useRef(false);

  // Her own initiative. Only once she is signed in and actually working, and
  // never over the top of anything she or the user is in the middle of.
  const pulse = usePulse({
    enabled: (session === 'ok' || session === 'open') && Boolean(state?.ready),
    busy:
      busy ||
      speech.speaking ||
      recorder.state !== 'idle' ||
      transcribing ||
      ambientAwakeRef.current,
    onSpeak: (text) => {
      if (voiceOn) speech.say(text);
    },
    onSaid: (message) => setMessages((current) => [...current, message]),
  });

  /**
   * Whose voice she answers to.
   *
   * Fetched once and kept, rather than read per utterance: it changes when the
   * user changes it and never otherwise, and asking the server whether to
   * listen every time somebody speaks would undo the point of deciding here.
   */
  const [guard, setGuard] = useState<GuardState | null>(null);
  useEffect(() => {
    void api.voiceGuard().then(setGuard).catch(() => {});
  }, []);

  /*
   * The spoken conversation, when there is a machine to hold one open.
   *
   * Declared before the listener below because the listener has to know
   * whether this is running: while a live session is up, the model on the
   * other end is doing the hearing, the turn-taking and the interrupting.
   * Leaving the older path awake at the same time would have two different
   * pieces of machinery answering the same sentence, which shows up as her
   * replying twice and being billed twice.
   *
   * Both halves of what is said are threaded into the transcript here, so
   * the spoken Grace and the typed one are visibly the same conversation.
   */
  const spokenIdRef = useRef(0);
  const appendSpoken = useCallback(
    (speaker: 'user' | 'grace', text: string) => {
      const said = text.trim();
      if (!said) return;
      spokenIdRef.current += 1;
      setMessages((current) => {
        const last = current[current.length - 1];
        /*
         * Transcription arrives in pieces as the sentence is spoken, not as
         * one finished line. Appending each piece separately turns "put the
         * kettle on" into three messages. Growing the last one instead keeps
         * it a sentence — but only when the same person is still talking.
         */
        if (last?.speaker === speaker && last.via === 'voice' && last.id.startsWith('live-')) {
          return [...current.slice(0, -1), {...last, text: `${last.text} ${said}`.trim()}];
        }
        return [
          ...current,
          {
            id: `live-${speaker}-${spokenIdRef.current}`,
            speaker,
            text: said,
            at: new Date().toISOString(),
            via: 'voice' as const,
          },
        ];
      });
    },
    [],
  );

  const live = useLive({
    deviceId,
    onHeard: (text) => appendSpoken('user', text),
    onSaid: (text) => appendSpoken('grace', text),
  });

  const ambient = useAmbient({
    enabled: micOn,
    deviceId,
    // Her own voice must never wake her, and the recorder must never be
    // fighting her for the microphone.
    paused:
      busy ||
      speech.speaking ||
      recorder.state !== 'idle' ||
      transcribing ||
      // A live session is holding the conversation; this listener's only
      // remaining job is the wake word that started it.
      live.state !== 'closed',
    onRequest: handleRequest,
    guard,
    /*
     * Told apart from `paused` on purpose.
     *
     * Paused covers everything that should stop her acting on what she hears.
     * This one is narrower: audio is genuinely coming out of the speakers right
     * now. During that, and only that, she keeps listening for her name so she
     * can be cut off mid-sentence — which is how you interrupt a person, and
     * the only alternative is waiting politely for a machine to finish reading
     * out something you already know.
     */
    speaking: speech.speaking,
    onBargeIn: () => speech.cancel(),
    // One note and nothing else. Being told at length that she is going quiet
    // is the opposite of what was asked for.
    onSleep: () => {
      speech.cancel();
      chimeDone();
    },
  });

  // One note when she wakes to her name, and not once per frame of hearing it.
  const wasAwakeRef = useRef(false);
  useEffect(() => {
    if (ambient.awake && !wasAwakeRef.current) chimeWake();
    wasAwakeRef.current = ambient.awake;
  }, [ambient.awake]);

  /*
   * Her name opens the line.
   *
   * This is the whole reason the wake word stays in the browser. The session
   * on the other end bills for every minute it is open, listening or not, so
   * leaving one running would be roughly two hundred dollars a month spent on
   * silence. The browser listens for nothing but her name, which costs
   * nothing, and only then is anything opened that costs anything at all.
   *
   * The result is what was actually asked for — no button, she is simply
   * there — with the part that would have emptied the account removed.
   */
  useEffect(() => {
    if (ambient.awake && live.available && live.state === 'closed') void live.begin();
  }, [ambient.awake, live]);

  /*
   * Told to leave it, or cut off mid-sentence, must hang up too.
   *
   * Otherwise the meter keeps running on a conversation that is visibly over,
   * for as long as the idle timer takes to notice — and "she stopped talking"
   * would not mean "she stopped costing money".
   */
  const liveEnd = live.end;
  useEffect(() => {
    if (!ambient.dormant) return;
    liveEnd();
  }, [ambient.dormant, liveEnd]);

  ambientAwakeRef.current = ambient.awake || ambient.state === 'hearing';
  // So /sleep reaches the listener without this hook depending on its order.
  ambientRef.current = ambient.sleep;

  // Only worth holding the machine awake while she is actually listening.
  useWakeLock(micOn);


  /**
   * The reliable route in. The browser records, the server transcribes, and
   * anything that goes wrong along the way says so.
   */
  const handleRecording = useCallback(
    async (audio: EncodedAudio) => {
      setMisheard(null);
      setTranscribing(true);
      try {
        const text = await api.transcribe(audio.base64, audio.mimeType);
        if (!text) {
          setMisheard('I couldn’t make out any words in that.');
          return;
        }
        await send(text, 'voice');
      } catch (cause) {
        if (cause instanceof NeedsPassword) setSession('required');
        else setMisheard((cause as Error).message);
      } finally {
        setTranscribing(false);
      }
    },
    [send],
  );

  // Held in a ref because the recorder is created before this callback exists:
  // the listener has to know the recorder's state, and the recorder has to be
  // able to hand its audio here.
  handleRecordingRef.current = handleRecording;

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    speech.cancel();
    setBusy(false);
    setStreaming('');
  }, [speech]);

  const applyProfile = useCallback((profile: Profile) => {
    setState((current) => (current ? {...current, profile} : current));
  }, []);

  const forget = useCallback(
    async (id: string) => applyProfile(await api.forgetEntry(id)),
    [applyProfile],
  );

  // Marking something no longer true, as opposed to deleting it: the honest
  // correction for "that used to be so and isn't now".
  const supersede = useCallback(
    async (text: string) => applyProfile(await api.supersede(text)),
    [applyProfile],
  );

  const rename = useCallback(
    async (addressAs: string | null) => applyProfile(await api.setAddressAs(addressAs)),
    [applyProfile],
  );

  const [google, setGoogle] = useState<GoogleStatus | null>(null);

  const refreshGoogle = useCallback(() => {
    api.googleStatus().then(setGoogle).catch(() => {});
  }, []);

  useEffect(() => {
    if (session === 'ok' || session === 'open') refreshGoogle();
  }, [session, refreshGoogle]);

  const setAttention = useCallback(async (next: AttentionMode) => {
    const mode = await api.setAttentionMode(next);
    setState((current) => (current ? {...current, mode} : current));
  }, []);

  const clear = useCallback(async () => {
    await api.clearConversation();
    setMessages([]);
    setStreaming('');
  }, []);

  const mode: Mode = useMemo(() => {
    if (state && !state.ready) return 'offline';
    // Recording wins over everything: it is the one state where what the
    // interface shows has to match what the microphone is doing.
    if (recorder.state === 'recording') return 'listening';
    if (recorder.state === 'working' || transcribing) return 'thinking';
    if (speech.speaking) return 'speaking';
    if (busy) return 'thinking';
    if (!micOn) return 'idle';
    // Someone is talking in the room, whether or not it turns out to be for her.
    if (ambient.state === 'hearing' || ambient.awake) return 'listening';
    if (ambient.state === 'working') return 'thinking';
    return 'waiting';
  }, [
    state,
    recorder.state,
    transcribing,
    speech.speaking,
    busy,
    micOn,
    ambient.state,
    ambient.awake,
  ]);

  return {
    session,
    state,
    messages,
    /** The spoken conversation: whether it is possible, and what it is doing. */
    live,
    streaming,
    searched,
    actions,
    asked,
    opening,
    error,
    mode,
    micOn,
    voiceOn,
    voiceMode,
    setVoiceMode,
    volume: speech.volume,
    setVolume: speech.setVolume,
    outputs: speech.outputs,
    output: speech.output,
    setOutput: speech.setOutput,
    ambient,
    guard,
    setGuard,
    recorder,
    pulse,
    transcribing,
    misheard,
    deviceId,
    setDeviceId,
    speech,
    setMicOn,
    // Re-reads the transcript from the server, for a conversation switch.
    reload: load,
    setVoiceOn,
    signIn,
    signOut,
    send,
    stop,
    forget,
    supersede,
    rename,
    clear,
    setAttention,
    google,
    refreshGoogle,
    disconnectGoogle: async () => {
      await api.disconnectGoogle();
      refreshGoogle();
    },
  };
}
