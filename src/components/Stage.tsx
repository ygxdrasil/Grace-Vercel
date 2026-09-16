import {X} from 'lucide-react';
import {useEffect} from 'react';
import type {DayView, GraceState} from '../../shared/types';
import {BEARING_WEIGHT, bearingOf, bearingWarns, type Reading} from '../../shared/bearing';
import type {Mode} from '../hooks/useGrace';
import {Reactor} from './Reactor';
import {Field, Gauge, Polar} from './hud/Parts';

/**
 * Her, taking over the screen — as an instrument panel.
 *
 * The laptop in the corner of the room stops being a laptop showing an app.
 * Everything is sized to be read from across a room rather than from arm's
 * length, which remains the only design rule that matters at this distance.
 *
 * The arrangement is the one a cockpit uses, because the problem is the same:
 * one thing you watch constantly in the middle, the quantities that drift
 * slowly down one side, the ones that move in real time down the other, and a
 * line along the bottom for whatever just happened.
 *
 * Every readout here is real. Nothing is drawn that cannot be filled with a
 * true value — which matters more than it sounds, because a panel of invented
 * telemetry is indistinguishable from a panel of real telemetry, and once you
 * suspect one number of being decorative you stop trusting all of them.
 */

interface Props {
  state: GraceState;
  day: DayView | null;
  mode: Mode;
  level: number;
  now: Date;
  onTalk: () => void;
  onClose: () => void;
  /** Whether the live voice is running, or she has fallen back to recording. */
  live?: {available: boolean; state: string; doing: string | null};
  /** Something she has asked and you have not answered. */
  asking?: boolean;
}

const LABEL: Record<Mode, string> = {
  offline: 'Offline',
  idle: 'Ready',
  waiting: 'Standby',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

function Column({side, children}: {side: 'left' | 'right'; children: React.ReactNode}) {
  return (
    <aside
      className={`hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto scroll-thin px-4 py-5 lg:flex ${
        side === 'left' ? 'border-r' : 'border-l'
      } border-ice/12`}>
      {children}
    </aside>
  );
}

function Group({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section className="space-y-2.5">
      <h2 className="readout border-b border-ice/12 pb-1.5 text-ice/60">{title}</h2>
      {children}
    </section>
  );
}

export function Stage({state, day, mode, level, now, onTalk, onClose, live, asking}: Props) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);

  const reading: Reading = {
    offline: mode === 'offline',
    listening: mode === 'waiting' || mode === 'listening',
    thinking: mode === 'thinking',
    speaking: mode === 'speaking',
    acting: Boolean(live?.doing),
    asking,
  };
  const bearing = bearingOf(reading);
  const warn = bearingWarns(bearing);

  const spend = state.spend;
  const onPool = spend.against === 'pool';
  /*
   * Ahead of where the money should be, or behind it.
   *
   * The credit has to last a fixed number of days, so "how much is left" on
   * its own says nothing — half of it gone is excellent in December and
   * alarming in September. This compares what has been spent against how much
   * of the window has passed, and only goes amber when it is genuinely ahead.
   */
  const pace =
    onPool && spend.elapsed !== null && spend.elapsed > 0.05
      ? spend.pool / spend.cap / spend.elapsed
      : 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-void">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-ice/15 px-4 py-2">
        <div className="flex min-w-0 items-center gap-4">
          <span className="readout text-ice">G.R.A.C.E.</span>
          <span className="readout text-mist/50">{LABEL[mode]}</span>
          <span className="readout hidden text-mist/35 sm:inline">
            [{live?.available ? 'LIVE' : 'RELAY'}]
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="readout tabular-nums text-ice/70">
            {now.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Leave full screen"
            className="text-mist/60 transition hover:text-ice">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Column side="left">
          <Group title="Credit">
            <Gauge
              label={onPool ? 'Pool used' : 'This month'}
              value={onPool ? spend.pool : spend.dollars}
              of={spend.cap}
              shown={`$${(onPool ? spend.pool : spend.dollars).toFixed(2)}`}
              warn={pace > 1.35 || spend.remaining <= 0}
            />
            {spend.elapsed !== null && (
              <Gauge
                label="Window elapsed"
                value={spend.elapsed}
                shown={`${Math.round(spend.elapsed * 100)}%`}
              />
            )}
            <Field label="Requests" value={String(spend.requests)} />
            <Field label="Paying" value={onPool ? 'Google credit' : 'Your card'} />
          </Group>

          <Group title="Today">
            {day && day.reminders.length > 0 ? (
              <ul className="space-y-1">
                {day.reminders.slice(0, 5).map((one) => (
                  <li key={one.id} className="truncate text-xs text-slate-300" title={one.text}>
                    {one.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="readout text-mist/40">Nothing outstanding</p>
            )}
          </Group>

          <Group title="She has been">
            {day && day.deeds.length > 0 ? (
              <ul className="space-y-1">
                {day.deeds.slice(0, 6).map((deed) => (
                  <li key={deed.id} className="truncate text-xs text-mist/70" title={deed.text}>
                    {deed.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="readout text-mist/40">Quiet so far</p>
            )}
          </Group>
        </Column>

        {/* Her. */}
        <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center px-6">
          {/* Corner brackets. They frame her as the instrument rather than as
              the empty middle of a layout, which is the whole job of the four
              cheapest elements on this screen. */}
          {(
            [
              ['left-6 top-6', 'border-l-2 border-t-2'],
              ['right-6 top-6', 'border-r-2 border-t-2'],
              ['bottom-6 left-6', 'border-b-2 border-l-2'],
              ['bottom-6 right-6', 'border-b-2 border-r-2'],
            ] as const
          ).map(([place, edges]) => (
            <span
              key={place}
              aria-hidden
              className={`pointer-events-none absolute h-7 w-7 border-ice/25 ${place} ${edges}`}
            />
          ))}

          <p className="font-serif text-[4.5rem] leading-none tracking-tight text-slate-100 tabular-nums sm:text-[6rem]">
            {now.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}
          </p>
          <p className="readout mt-1 text-mist/40">
            {now.toLocaleDateString('en-GB', {weekday: 'long', day: 'numeric', month: 'long'})}
          </p>

          <div className="mt-6">
            <Reactor mode={mode} level={level} onPress={onTalk} size="stage" />
          </div>

          {/*
           * What she is doing, and how she is going about it.
           *
           * Two lines rather than one, because they answer different
           * questions. The first is what is happening — thinking, speaking,
           * standing by. The second is her bearing, which is what a mood
           * stands in for: how hard she is concentrating, whether she is
           * busy, whether she is waiting on you. She has no feelings and this
           * invents none; every word of it is read from something measured.
           */}
          <p className="readout mt-5 text-mist/55">{LABEL[mode]}</p>
          <p
            className="mt-1 text-sm uppercase tracking-[0.3em] transition-opacity duration-700"
            style={{
              color: warn ? 'var(--color-ember)' : 'rgb(var(--accent))',
              opacity: BEARING_WEIGHT[bearing],
            }}>
            {bearing}
          </p>
          {live?.doing && (
            <p className="readout mt-2 text-ice/50">{live.doing.replace(/_/g, ' ')}</p>
          )}
        </div>

        <Column side="right">
          <Group title="Mic level / polar">
            <div className="grid place-items-center py-1">
              <Polar level={level} live={mode === 'listening' || mode === 'waiting'} />
            </div>
            <Gauge label="Audio level" value={level} shown={level.toFixed(3)} />
          </Group>

          <Group title="Session">
            <Field label="Model" value={state.model} />
            <Field label="Voice" value={live?.available ? 'Live, native' : 'Recorded'} />
            <Field label="Bearing" value={bearing} />
            <Field label="Memory" value={state.storage.backend} />
            <Field label="At rest" value={state.storage.encrypted ? 'Encrypted' : 'Plain'} />
            <Field label="Confirms" value={`${state.policies.length} rules`} />
          </Group>
        </Column>
      </div>

      {/* The ticker. The last thing she said, along the bottom, because on a
          screen across a room the most recent sentence is the only part of
          the conversation you can actually read. */}
      <footer className="flex shrink-0 items-center gap-3 border-t border-ice/15 px-4 py-2">
        <span className="readout shrink-0 text-ice/50">Last</span>
        <p className="truncate text-xs text-mist/70">
          {state.messages[state.messages.length - 1]?.text ?? 'Nothing said yet.'}
        </p>
      </footer>
    </div>
  );
}
