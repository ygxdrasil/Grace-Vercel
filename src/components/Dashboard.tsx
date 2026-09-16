import {Brain, CalendarDays, Ear, Globe, Mail, Volume2} from 'lucide-react';
import {useEffect, useMemo, useState} from 'react';
import type {
  AttentionMode,
  Concern,
  GoogleStatus,
  GraceState,
  Workspace,
} from '../../shared/types';
import type {Mode} from '../hooks/useGrace';
import {Day} from './Day';
import {Files} from './Files';
import {NotesPanel, SituationsPanel} from './Keep';
import {Connections, LiveFeed, SpendGauge, Weather} from './Panels';
import {GithubPanel, WorkflowsPanel} from './Work';
import {Faculties, type Faculty} from './Faculties';
import {Reactor} from './Reactor';

/** Kept in step with server/modes.ts, which is where the behaviour lives. */
const MODES: {id: AttentionMode; label: string; blurb: string}[] = [
  {id: 'open', label: 'Open', blurb: 'Speaks up when it’s worth it'},
  {id: 'work', label: 'Work', blurb: 'Brisk. Personal matters wait'},
  {id: 'focus', label: 'Focus', blurb: 'Answers only, nothing offered'},
  {id: 'away', label: 'Away', blurb: 'Takes messages and holds them'},
];

const MODE_LABEL: Record<Mode, string> = {
  offline: 'Not configured',
  idle: 'Ready',
  waiting: 'Listening for “Grace”',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

declare const __BUILD__: string;

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function sinceLabel(iso: string): string {
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started) || started <= 0) return '';
  const minutes = Math.floor((Date.now() - started) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

interface DashboardProps {
  state: GraceState;
  mode: Mode;
  micLevel: number;
  recording: boolean;
  micBusy: boolean;
  micError: string | null;
  voiceSource: 'grace' | 'browser';
  voiceOn: boolean;
  google: GoogleStatus | null;
  /** What she has noticed on her own, and why she may be holding it back. */
  concerns: Concern[];
  held: string | null;
  lastLookedAt: number | null;
  /** Which room you are in. Decides what this panel shows. */
  room: Workspace | null;
  onSetAttention: (mode: AttentionMode) => void;
  onTalk: () => void;
  onOpenSoundCheck: () => void;
}

/**
 * The panel that makes her feel present rather than parked.
 *
 * Everything here is real, and everything here is something you cannot simply
 * ask her for: the time, what the microphone is doing this instant, which of
 * her faculties are lit, how much attention she may take. Anything she could
 * just say out loud — what she has learned, where you left off, how many
 * exchanges you have had — was taken out, because a wall of text you have
 * already read is noise no matter how true it is.
 */
export function Dashboard({
  state,
  mode,
  micLevel,
  recording,
  micBusy,
  micError,
  voiceSource,
  voiceOn,
  google,
  concerns,
  held,
  lastLookedAt,
  room,
  onSetAttention,
  onTalk,
  onOpenSoundCheck,
}: DashboardProps) {
  const now = useClock();
  // A room lists the panels it wants. An unknown or empty room shows
  // everything, which is what the single-screen version always did.
  const wants = (name: string) =>
    !room || room.panels.length === 0 || room.panels.includes(name);
  const attention = state.mode.mode;
  const heldFor = sinceLabel(state.mode.since);

  const faculties = useMemo<Faculty[]>(
    () => [
      {
        id: 'hearing',
        label: 'Hearing',
        detail: micError
          ? 'Needs a look'
          : recording
            ? 'Listening now'
            : 'Ready',
        health: micError ? 'degraded' : recording ? 'live' : 'idle',
        icon: <Ear size={14} />,
      },
      {
        id: 'voice',
        label: 'Voice',
        detail: !voiceOn
          ? 'Muted'
          : voiceSource === 'grace'
            ? 'Her own'
            : 'Browser’s',
        health: !voiceOn ? 'idle' : voiceSource === 'grace' ? 'live' : 'degraded',
        icon: <Volume2 size={14} />,
      },
      {
        id: 'memory',
        label: 'Memory',
        detail: `${state.profile.entries.length} held`,
        health: 'live',
        icon: <Brain size={14} />,
      },
      {
        id: 'web',
        label: 'Web',
        detail: 'Searches when needed',
        health: 'live',
        icon: <Globe size={14} />,
      },
      {
        id: 'mail',
        label: 'Mail',
        detail: google?.problem
          ? 'Needs reconnecting'
          : google?.connected
            ? 'Reading only'
            : 'Not connected',
        health: google?.problem ? 'degraded' : google?.connected ? 'live' : 'absent',
        icon: <Mail size={14} />,
      },
      {
        id: 'diary',
        label: 'Diary',
        detail: google?.problem
          ? 'Needs reconnecting'
          : google?.connected
            ? 'Reading your day'
            : 'Not connected',
        health: google?.problem ? 'degraded' : google?.connected ? 'live' : 'absent',
        icon: <CalendarDays size={14} />,
      },
    ],
    [google, micError, recording, state.profile.entries.length, voiceOn, voiceSource],
  );

  return (
    <div
      className={`scroll-thin flex h-full flex-col gap-5 overflow-y-auto px-5 py-5 ${
        mode === 'thinking' ? 'sheen' : ''
      }`}>
      <div className="flex flex-col items-center">
        {/* The orb is the control now, not an ornament. Pressing it is the one
            way in that cannot be got wrong. */}
        <Reactor mode={mode} level={micLevel} onPress={onTalk} />
        <p className="mt-1 text-[0.65rem] uppercase tracking-[0.2em] text-mist/60">
          {micBusy ? 'Working' : MODE_LABEL[mode]}
        </p>
      </div>

      <div className="text-center">
        <p className="figure font-serif text-5xl tracking-wide text-slate-100">
          {/* Keyed on the minute, so the new figure settles in rather than
              swapping. It is the one thing on screen that is always true. */}
          <span key={now.getMinutes()} className="settle inline-block">
            {now.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}
          </span>
        </p>
        {/* The minute filling up. Slow enough to be atmosphere, not a timer. */}
        <div className="mx-auto mt-1.5 h-px w-24 overflow-hidden bg-edge">
          <div className="sweep h-full w-full bg-ice/50" />
        </div>
        <p className="mt-1.5 text-xs text-mist/60">
          {now.toLocaleDateString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </p>
      </div>

      {(wants('day') || wants('needs') || wants('deeds')) && (
        <Day refreshKey={lastLookedAt} concerns={concerns} held={held} />
      )}

      {wants('weather') && <Weather />}
      {wants('github') && <GithubPanel />}
      {wants('workflows') && <WorkflowsPanel />}
      {wants('notes') && <NotesPanel />}
      {wants('files') && <Files />}
      {wants('situations') && <SituationsPanel />}
      {wants('activity') && <LiveFeed />}
      {wants('connections') && <Connections google={google} />}
      {wants('spend') && <SpendGauge spend={state.spend} />}

      {wants('faculties') && (
      <div>
        <h3 className="label mb-2">
          Faculties
        </h3>
        <Faculties
          faculties={faculties}
          onSelect={(id) => {
            if (id === 'hearing' || id === 'voice') onOpenSoundCheck();
            if ((id === 'mail' || id === 'diary') && google?.configured) {
              // A full page visit rather than a fetch: Google's consent screen
              // will not load inside anything.
              window.location.href = '/api/google-start';
            }
          }}
        />

        {google && !google.connected && (
          <div className="mt-2 rounded-lg border border-edge/70 bg-surface/40 px-3 py-2.5">
            {google.configured ? (
              // No explaining sentence above it: the button says what it does,
              // and she can be asked why it matters.
              <a
                href="/api/google-start"
                className="inline-block rounded-full border border-ice/40 bg-ice/15 px-3 py-1 text-xs text-ice transition hover:bg-ice/25">
                Connect Google
              </a>
            ) : (
              <p className="text-xs leading-relaxed text-mist/70">
                Mail and diary need Google keys —{' '}
                <span className="font-mono text-mist/90">GOOGLE-SETUP.md</span>.
              </p>
            )}
          </div>
        )}

        {google?.problem && (
          <p className="mt-2 rounded-lg border border-ember/25 bg-ember/10 px-3 py-2 text-xs leading-relaxed text-ember/90">
            {google.problem}{' '}
            <a href="/api/google-start" className="underline underline-offset-2">
              Reconnect
            </a>
          </p>
        )}
      </div>
      )}

      {wants('attention') && (
      <div>
        <h3 className="label mb-2">
          Attention {heldFor && <span className="text-mist/35">· {heldFor}</span>}
        </h3>
        <div className="grid grid-cols-2 gap-1.5">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onSetAttention(option.id)}
              title={option.blurb}
              aria-pressed={attention === option.id}
              className={`rounded-lg border px-2 py-2 text-left transition ${
                attention === option.id
                  ? 'border-ice/40 bg-ice/15 text-ice'
                  : 'border-edge bg-surface/40 text-mist hover:border-ice/30 hover:text-slate-200'
              }`}>
              {/* The blurb lives in the tooltip. You learn what these four mean
                  once; after that the sentence under each is furniture. */}
              <span className="block text-xs font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
      )}

      {/* The money and the build, in one line, because the first is a promise
          I made and the second is how we tell a stale page from a live one.
          Everything else that used to sit here she can simply be asked. */}
      <p
        className="pb-2 text-center text-[0.6rem] text-mist/30"
        title={`${state.profile.entries.length} things remembered · ${state.storage.backend} · ${
          state.storage.encrypted ? 'encrypted' : 'plain'
        } · ${state.model}`}>
        <span
          className={state.spend.dollars >= state.spend.cap ? 'text-rose-300' : undefined}>
          ${state.spend.dollars.toFixed(2)} of ${state.spend.cap}
        </span>{' '}
        · build {typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'}
      </p>
    </div>
  );
}
