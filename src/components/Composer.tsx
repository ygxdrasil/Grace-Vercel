import {AudioLines, Mic, MicOff, Send, Square, Volume2, VolumeX} from 'lucide-react';
import {useMemo, useState, type ReactNode} from 'react';
import {suggest} from '../../shared/commands';

interface ComposerProps {
  /** A request is in flight. Sending another would collide with it. */
  busy: boolean;
  /** There is something to interrupt — a request, or Grace mid-sentence. */
  canStop: boolean;
  micOn: boolean;
  /** True while the microphone is held open across turns. */
  lineOpen: boolean;
  voiceOn: boolean;
  micSupported: boolean;
  voiceSupported: boolean;
  /** She is already capturing a request. */
  awake: boolean;
  /** Recording state, and how loud the microphone is hearing you right now. */
  recording: boolean;
  recorderBusy: boolean;
  level: number;
  onRecordStart: () => void;
  onRecordStop: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onToggleMic: () => void;
  onToggleVoice: () => void;
  /** Start capturing straight away, without waiting for the wake word. */
  onTalk: () => void;
}

function ToggleButton({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-9 min-w-9 place-items-center border px-1.5 transition disabled:cursor-not-allowed disabled:opacity-30 ${
        active
          ? 'border-ice/40 bg-ice/15 text-ice'
          : 'border-ice/15 bg-void/40 text-mist/60 hover:border-ice/35 hover:text-ice'
      }`}>
      {children}
    </button>
  );
}

export function Composer({
  busy,
  canStop,
  micOn,
  lineOpen,
  voiceOn,
  micSupported,
  voiceSupported,
  awake,
  recording,
  recorderBusy,
  level,
  onRecordStart,
  onRecordStop,
  onSend,
  onStop,
  onToggleMic,
  onToggleVoice,
  onTalk,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  /** Which suggestion is highlighted, and the list itself. */
  const [picked, setPicked] = useState(0);
  const options = useMemo(() => suggest(draft), [draft]);

  /** Fill the name in and leave the cursor ready for whatever it takes. */
  const complete = (name: string) => {
    setDraft(`/${name} `);
    setPicked(0);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  };

  return (
    <div className="flex items-center gap-2 bg-void/60 px-3 py-2">
      {/*
        Whether she is listening, in a word.

        It was a 17px icon and a tooltip — on a panel where everything else is
        a labelled readout, the one control whose state decides whether she can
        hear you at all was the one you had to hover to read. Two icons that
        differ by a small diagonal stroke are not a state; pressing it to
        "open the microphone" when it was already open closes it, and the
        result is indistinguishable from her having gone deaf.
      */}
      <ToggleButton
        active={micOn}
        disabled={!micSupported}
        label={
          micSupported
            ? micOn
              ? 'Always listening — say “Grace”. Press to stop.'
              : 'Not listening. Press so she hears “Grace” from across the room.'
            : 'This browser cannot listen'
        }
        onClick={onToggleMic}>
        <span className="flex items-center gap-1.5">
          {micOn ? <Mic size={17} /> : <MicOff size={17} />}
          <span className="readout hidden text-[0.55rem] sm:inline">
            {micOn ? 'EAR ON' : 'EAR OFF'}
          </span>
        </span>
      </ToggleButton>

      <ToggleButton
        active={voiceOn}
        disabled={!voiceSupported}
        label={
          voiceSupported
            ? voiceOn
              ? 'Grace speaks her replies'
              : 'Grace stays silent'
            : 'This browser has no speech synthesis'
        }
        onClick={onToggleVoice}>
        {voiceOn ? <Volume2 size={17} /> : <VolumeX size={17} />}
      </ToggleButton>

      {/* The dependable way in. Press, speak, press again — the recording is
          transcribed on the server, so it works in browsers that have no
          speech recognition of their own. The bar fills with however loud the
          microphone is hearing you, which is the fastest way to tell a quiet
          room from a dead microphone. */}
      <button
        type="button"
        onClick={lineOpen ? onRecordStop : onRecordStart}
        aria-label={
          lineOpen
            ? 'The line is open — speak whenever you like. Press to close it.'
            : 'Open the line and leave it open'
        }
        aria-pressed={lineOpen}
        className={`readout relative flex shrink-0 items-center gap-1.5 overflow-hidden border px-3 py-2.5 transition ${
          recording
            ? 'border-ice/60 bg-ice/20 text-ice'
            : lineOpen
              // Open but not this second: she has the microphone, briefly.
              ? 'border-ice/40 bg-ice/10 text-ice/80'
              : 'border-ice/15 bg-void/40 text-mist/60 hover:border-ice/35 hover:text-ice'
        }`}>
        {recording && (
          <span
            className="absolute inset-y-0 left-0 bg-ice/25 transition-[width] duration-75"
            style={{width: `${Math.min(100, level * 180)}%`}}
          />
        )}
        <AudioLines size={15} className="relative" />
        <span className="relative hidden sm:inline">
          {recording
            ? 'Listening'
            : recorderBusy
              ? 'One moment'
              : lineOpen
                ? 'Open'
                : 'Speak'}
        </span>
      </button>

      {/* Only useful where the browser supports a wake word at all. */}
      {micOn && !recording && (
        <button
          type="button"
          onClick={onTalk}
          aria-label="Listen for a spoken request"
          className={`readout hidden shrink-0 border px-3 py-2.5 transition lg:block ${
            awake
              ? 'border-ice/50 bg-ice/20 text-ice'
              : 'border-ice/15 bg-void/40 text-mist/60 hover:border-ice/35 hover:text-ice'
          }`}>
          {awake ? 'Listening' : 'Wake'}
        </button>
      )}

      {/*
        The command menu.

        Appears on a lone slash and disappears the moment there is an argument,
        because by then you know what you are doing and a list over the box is
        just something covering the words you are typing. Arrow keys and Enter,
        because anyone who types a slash expects arrow keys and Enter.
      */}
      <div className="relative min-w-0 flex-1">
        {options.length > 0 && (
          <div className="glass absolute bottom-full left-0 z-30 mb-2 w-full max-w-md overflow-hidden p-1">
            {options.map((option, index) => (
              <button
                key={option.name}
                type="button"
                onMouseEnter={() => setPicked(index)}
                onClick={() => complete(option.name)}
                className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left transition ${
                  index === picked ? 'bg-ice/15' : 'hover:bg-surface/60'
                }`}>
                <span
                  className={`font-mono text-xs ${
                    index === picked ? 'text-ice' : 'text-slate-200'
                  }`}>
                  /{option.name}
                </span>
                {option.takes && (
                  <span className="font-mono text-[0.65rem] text-mist/50">
                    {option.takes}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[0.7rem] text-mist/70">
                  {option.blurb}
                </span>
              </button>
            ))}
            {options.length === 1 && options[0].costs && (
              <p className="px-2.5 pb-1 pt-0.5 text-[0.65rem] text-mist/45">
                Costs: {options[0].costs}
              </p>
            )}
          </div>
        )}

        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (options.length > 0) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setPicked(
                  (now) =>
                    (now + (event.key === 'ArrowDown' ? 1 : options.length - 1)) %
                    options.length,
                );
                return;
              }
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault();
                complete(options[picked].name);
                return;
              }
              if (event.key === 'Escape') {
                setDraft('');
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="SAY SOMETHING, OR / FOR COMMANDS"
          className="w-full border border-ice/15 bg-void/40 px-3 py-2.5 text-xs uppercase tracking-[0.12em] text-ice/90 placeholder:text-mist/30 focus:border-ice/40 focus:outline-none"
          style={{fontFamily: 'var(--font-mono)'}}
        />
      </div>

      {canStop ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop"
          className="grid h-9 w-9 place-items-center border border-ice/15 bg-void/40 text-mist/60 transition hover:border-ice/35 hover:text-ice">
          <Square size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          aria-label="Send"
          className="grid h-9 w-9 place-items-center border border-ice/40 bg-ice/10 text-ice transition hover:bg-ice/20 disabled:opacity-25">
          <Send size={16} />
        </button>
      )}
    </div>
  );
}
