import {Mic, MicOff, Send, Square, Volume2, VolumeX} from 'lucide-react';
import {useState, type ReactNode} from 'react';

interface ComposerProps {
  /** A request is in flight. Sending another would collide with it. */
  busy: boolean;
  /** There is something to interrupt — a request, or Grace mid-sentence. */
  canStop: boolean;
  micOn: boolean;
  voiceOn: boolean;
  micSupported: boolean;
  voiceSupported: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onToggleMic: () => void;
  onToggleVoice: () => void;
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
      className={`grid h-10 w-10 place-items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-30 ${
        active
          ? 'border-ice/40 bg-ice/15 text-ice'
          : 'border-edge bg-surface text-mist hover:text-slate-200'
      }`}>
      {children}
    </button>
  );
}

export function Composer({
  busy,
  canStop,
  micOn,
  voiceOn,
  micSupported,
  voiceSupported,
  onSend,
  onStop,
  onToggleMic,
  onToggleVoice,
}: ComposerProps) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  };

  return (
    <div className="flex items-center gap-2 border-t border-edge/70 bg-surface/60 px-4 py-3 backdrop-blur">
      <ToggleButton
        active={micOn}
        disabled={!micSupported}
        label={
          micSupported
            ? micOn
              ? 'Microphone on'
              : 'Microphone off'
            : 'This browser has no speech recognition'
        }
        onClick={onToggleMic}>
        {micOn ? <Mic size={17} /> : <MicOff size={17} />}
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

      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="Say something to Grace"
        className="min-w-0 flex-1 rounded-full border border-edge bg-surface px-4 py-2.5 text-sm text-slate-200 placeholder:text-mist/50 focus:border-ice/40 focus:outline-none"
      />

      {canStop ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop"
          className="grid h-10 w-10 place-items-center rounded-full border border-edge bg-surface text-mist transition hover:text-slate-200">
          <Square size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          aria-label="Send"
          className="grid h-10 w-10 place-items-center rounded-full border border-ice/40 bg-ice/15 text-ice transition hover:bg-ice/25 disabled:opacity-25">
          <Send size={16} />
        </button>
      )}
    </div>
  );
}
