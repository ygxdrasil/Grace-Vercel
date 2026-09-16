import {X} from 'lucide-react';
import {useEffect} from 'react';
import type {DayView, GraceState} from '../../shared/types';
import type {Mode} from '../hooks/useGrace';
import {Reactor} from './Reactor';
import {Waveform} from './Waveform';

/**
 * Her, taking over the screen.
 *
 * The laptop in the corner of the room stops being a laptop showing an app and
 * becomes the thing she is. Everything here is sized to be read from across a
 * room rather than from arm's length, which is the only design rule that
 * matters at this distance.
 *
 * Panels sit in an arc around her, tilted away on both sides. That is a
 * perspective trick, not depth — the light stays inside the glass. What it
 * cannot do is leave the screen, and no amount of CSS will change that.
 */

interface Props {
  state: GraceState;
  day: DayView | null;
  mode: Mode;
  level: number;
  now: Date;
  onTalk: () => void;
  onClose: () => void;
}

const LABEL: Record<Mode, string> = {
  offline: 'Offline',
  idle: 'Ready',
  waiting: 'Listening for “Grace”',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

function Wing({
  side,
  children,
}: {
  side: 'left' | 'right';
  children: React.ReactNode;
}) {
  return (
    <div
      className="hidden w-72 shrink-0 flex-col gap-3 lg:flex"
      style={{
        transform: `perspective(1400px) rotateY(${side === 'left' ? 22 : -22}deg)`,
        transformOrigin: side === 'left' ? 'right center' : 'left center',
      }}>
      {children}
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass bracket px-4 py-3">
      <h3 className="mb-1.5 text-[0.6rem] uppercase tracking-[0.2em] text-mist/60">
        {title}
      </h3>
      {children}
    </div>
  );
}

export function Stage({state, day, mode, level, now, onTalk, onClose}: Props) {
  // Escape is what everyone tries first, so it must work.
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const soon = day?.events.filter(
    (event) => new Date(event.start).toDateString() === now.toDateString(),
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-void/95">
      <button
        type="button"
        onClick={onClose}
        aria-label="Leave full screen"
        className="absolute right-4 top-4 z-10 rounded-full border border-edge p-2 text-mist/60 transition hover:text-slate-200">
        <X size={16} />
      </button>

      <div className="flex flex-1 items-center justify-center gap-8 px-8">
        <Wing side="left">
          <Card title="Today">
            {soon && soon.length > 0 ? (
              <ul className="space-y-1.5">
                {soon.slice(0, 4).map((event) => (
                  <li key={event.id} className="text-sm text-slate-200">
                    <span className="accent tabular-nums">
                      {new Date(event.start).toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>{' '}
                    {event.summary}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-mist/60">Nothing in the diary.</p>
            )}
          </Card>

          <Card title="Needs you">
            {day && day.reminders.length > 0 ? (
              <ul className="space-y-1">
                {day.reminders.slice(0, 4).map((one) => (
                  <li key={one.id} className="text-sm text-slate-200">
                    {one.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-mist/60">Nothing outstanding.</p>
            )}
          </Card>
        </Wing>

        {/* Her. */}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center">
          <p className="font-serif text-[5.5rem] leading-none tracking-tight text-slate-100 tabular-nums sm:text-[8rem]">
            {now.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}
          </p>
          <p className="mt-1 text-xs uppercase tracking-[0.3em] text-mist/50">
            {now.toLocaleDateString('en-GB', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>

          <div className="mt-8 w-full max-w-2xl">
            {/* Her, and then her voice. The reactor is the thing you look
                at across a room; the trace underneath is the detail you only
                read when you are close enough to care. */}
            <Reactor mode={mode} level={level} onPress={onTalk} size="stage" />
            <Waveform mode={mode} level={level} height={64} />
          </div>

          <p className="mt-4 text-sm uppercase tracking-[0.28em] text-mist/70">
            {LABEL[mode]}
          </p>
        </div>

        <Wing side="right">
          <Card title="She has been">
            {day && day.deeds.length > 0 ? (
              <ul className="space-y-1">
                {day.deeds.slice(0, 5).map((deed) => (
                  <li key={deed.id} className="truncate text-sm text-slate-300">
                    {deed.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-mist/60">Quiet so far.</p>
            )}
          </Card>

          <Card title="This month">
            <p className="font-serif text-3xl text-slate-100 tabular-nums">
              ${state.spend.dollars.toFixed(2)}
              <span className="ml-1 text-sm text-mist/50">of ${state.spend.cap}</span>
            </p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-edge">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, (state.spend.dollars / state.spend.cap) * 100)}%`,
                  background: 'rgb(var(--accent))',
                }}
              />
            </div>
            <p className="mt-1.5 text-[0.65rem] text-mist/50">
              {state.spend.requests} requests · {state.storage.backend}
            </p>
          </Card>
        </Wing>
      </div>
    </div>
  );
}
