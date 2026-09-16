import {useEffect} from 'react';
import type {DayView, GraceState} from '../../shared/types';
import {bearingOf, bearingWarns, type Reading} from '../../shared/bearing';
import type {Mode} from '../hooks/useGrace';
import {Core} from './hud/Core';
import {Polar} from './hud/Parts';

/**
 * The panel, laid out the way the reference is laid out.
 *
 * Structure first, because the structure is most of the resemblance: a thin
 * rule across the top carrying identity and state, two narrow columns of
 * readouts pinned hard to the edges, the instrument alone in the middle with
 * nothing but brackets near it, and a ticker along the bottom.
 *
 * Then the type, which is the rest of it. Everything is small, upper case,
 * widely tracked and dim — almost nothing on a real panel is bright, and the
 * handful of things that are bright are the things that matter. The
 * temptation is to make labels readable at a glance; the reference resists
 * it, and resisting it is why the reference looks like equipment.
 *
 * Every figure is read from something. The Japanese captions in the reference
 * are the one thing not reproduced: filler text in a language neither of us
 * is reading would be decoration pretending to be data, which is the single
 * thing this panel is built not to do.
 */

interface Props {
  state: GraceState;
  day: DayView | null;
  mode: Mode;
  level: number;
  now: Date;
  onTalk: () => void;
  onClose: () => void;
  live?: {available: boolean; state: string; doing: string | null};
  asking?: boolean;
  tools?: number;
}

const LABEL: Record<Mode, string> = {
  offline: 'OFFLINE',
  idle: 'READY',
  waiting: 'STANDBY',
  listening: 'LISTENING',
  thinking: 'THINKING',
  speaking: 'SPEAKING',
};

/** A section rule with a label sitting on it. */
function Head({children}: {children: React.ReactNode}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="readout whitespace-nowrap text-ice/55">{children}</span>
      <span className="h-px flex-1 bg-ice/15" />
    </div>
  );
}

/**
 * One row: label, bar, value.
 *
 * `tone` is not styling for its own sake. Green means running, amber means
 * something wants you, cyan is everything else — and because those meanings
 * are fixed, a glance down the column tells you whether anything is wrong
 * without reading a single word.
 */
function Row({
  label,
  value,
  share,
  tone = 'ice',
}: {
  label: string;
  value: string;
  share?: number;
  tone?: 'ice' | 'live' | 'warn';
}) {
  const colour =
    tone === 'live'
      ? 'var(--color-live)'
      : tone === 'warn'
        ? 'var(--color-ember)'
        : 'rgb(var(--accent))';

  return (
    <div className="mb-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="readout truncate text-mist/50">{label}</span>
        <span className="readout shrink-0 tabular-nums" style={{color: colour}}>
          {value}
        </span>
      </div>
      {share !== undefined && (
        <div className="mt-1 h-[2px] w-full bg-ice/10">
          <div
            className="h-full transition-[width] duration-700 ease-out"
            style={{width: `${Math.max(0, Math.min(1, share)) * 100}%`, background: colour}}
          />
        </div>
      )}
    </div>
  );
}

export function Stage({
  state,
  day,
  mode,
  level,
  now,
  onTalk,
  onClose,
  live,
  asking,
  tools,
}: Props) {
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
  const busy = mode === 'thinking' || mode === 'speaking' || Boolean(live?.doing);

  const spend = state.spend;
  const onPool = spend.against === 'pool';
  const used = onPool ? spend.pool : spend.dollars;
  // Amber on pace, not on amount: half the pool gone is excellent in December
  // and alarming in September.
  const ahead =
    onPool && spend.elapsed !== null && spend.elapsed > 0.05
      ? used / spend.cap / spend.elapsed > 1.35
      : false;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-void"
      style={{fontFamily: 'var(--font-mono)'}}>
      {/* ---- top rule ---- */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-ice/15 px-4 py-2">
        <div className="flex min-w-0 items-center gap-4">
          <span
            className="whitespace-nowrap text-[0.78rem] tracking-[0.34em] text-ice"
            style={{textShadow: '0 0 12px rgb(var(--accent) / 0.55)'}}>
            G.R.A.C.E.
          </span>
          <span className="readout flex items-center gap-1.5 text-mist/60">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: warn ? 'var(--color-ember)' : 'rgb(var(--accent))',
                boxShadow: `0 0 6px ${warn ? 'var(--color-ember)' : 'rgb(var(--accent))'}`,
              }}
            />
            {LABEL[mode]}
          </span>
          <span className="readout hidden text-mist/30 md:inline">
            [{live?.available ? 'LIVE NATIVE AUDIO' : 'RELAY FALLBACK'}]
          </span>
          <span className="readout hidden text-mist/30 lg:inline">
            TLS {state.storage.encrypted ? 'OK' : '---'}
          </span>
        </div>

        <div className="flex items-baseline gap-4">
          <div className="text-right">
            <div className="text-lg leading-none tabular-nums text-ice">
              {now.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}
            </div>
            <div className="readout mt-0.5 text-mist/35">
              {now.toISOString().slice(0, 10)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Leave full screen"
            className="readout text-mist/40 transition hover:text-ice">
            ESC
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- left column ---- */}
        <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto scroll-thin px-3 py-4 lg:flex">
          <Head>VITALS</Head>
          <Row
            label={onPool ? 'CREDIT' : 'MONTH'}
            value={`$${used.toFixed(3)}`}
            share={used / spend.cap}
            tone={ahead ? 'warn' : 'ice'}
          />
          {spend.elapsed !== null && (
            <Row
              label="WINDOW"
              value={`${Math.round(spend.elapsed * 100)}%`}
              share={spend.elapsed}
            />
          )}
          <Row label="REQUESTS" value={String(spend.requests)} />
          <Row
            label="VOICE"
            value={live?.available ? 'OPEN' : 'RELAY'}
            tone={live?.available ? 'live' : 'ice'}
          />
          <Row
            label="MEMORY"
            value={state.ready ? 'RUNNING' : 'IDLE'}
            tone={state.ready ? 'live' : 'ice'}
          />
          <Row label="STORE" value={state.storage.backend.toUpperCase()} />
          <Row label="CRYPTO" value={state.storage.encrypted ? 'AES-256' : 'NONE'} />

          <div className="mt-4">
            <Head>OUTSTANDING</Head>
            {day && day.reminders.length > 0 ? (
              <ul className="space-y-1">
                {day.reminders.slice(0, 6).map((one) => (
                  <li
                    key={one.id}
                    className="readout truncate text-mist/60"
                    title={one.text}>
                    {one.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="readout text-mist/25">NONE</p>
            )}
          </div>

          <div className="mt-4">
            <Head>LOG</Head>
            {day && day.deeds.length > 0 ? (
              <ul className="space-y-1">
                {day.deeds.slice(0, 8).map((deed) => (
                  <li
                    key={deed.id}
                    className="readout truncate text-mist/40"
                    title={deed.text}>
                    {deed.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="readout text-mist/25">QUIET</p>
            )}
          </div>
        </aside>

        {/* ---- centre ---- */}
        <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center">
          {(
            [
              ['left-5 top-5', 'border-l border-t'],
              ['right-5 top-5', 'border-r border-t'],
              ['bottom-5 left-5', 'border-b border-l'],
              ['bottom-5 right-5', 'border-b border-r'],
            ] as const
          ).map(([place, edges]) => (
            <span
              key={place}
              aria-hidden
              className={`pointer-events-none absolute h-8 w-8 border-ice/30 ${place} ${edges}`}
            />
          ))}

          <button
            type="button"
            onClick={onTalk}
            aria-label="Talk to Grace"
            className="rounded-full outline-none transition-transform focus-visible:ring-1 focus-visible:ring-ice/50 active:scale-[0.99]">
            <Core level={level} active={busy} size={420} />
          </button>

          {/* State, then bearing. Two lines because they answer different
              questions: what is happening, and how she is going about it. */}
          <p className="mt-6 text-[0.8rem] tracking-[0.42em] text-ice/85">{LABEL[mode]}</p>
          <p
            className="mt-2 text-[0.62rem] uppercase tracking-[0.3em] transition-opacity duration-700"
            style={{color: warn ? 'var(--color-ember)' : 'rgb(var(--accent) / 0.55)'}}>
            {live?.doing ? live.doing.replace(/_/g, ' ') : bearing}
          </p>
        </main>

        {/* ---- right column ---- */}
        <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto scroll-thin px-3 py-4 lg:flex">
          <Head>MIC LEVEL / POLAR</Head>
          <div className="grid place-items-center py-1">
            <Polar level={level} live={mode === 'listening' || mode === 'waiting'} size={150} />
          </div>

          <div className="mt-3">
            <Head>AUDIO LEVEL</Head>
            <Row label="RMS" value={level.toFixed(3)} share={level} />
          </div>

          <div className="mt-3">
            <Head>SESSION</Head>
            <Row label="MODEL" value={state.model} />
            <Row label="VOICE" value={live?.available ? 'NATIVE' : 'RECORDED'} />
            <Row label="LANG" value="EN-GB" />
            <Row label="WAKE" value="GRACE" />
            <Row label="BEARING" value={bearing.toUpperCase()} tone={warn ? 'warn' : 'ice'} />
            <Row label="TOOLS" value={tools === undefined ? '--' : String(tools)} />
            <Row label="CONFIRMS" value={String(state.policies.length)} />
            <Row label="PAYING" value={onPool ? 'CREDIT' : 'CARD'} tone={onPool ? 'ice' : 'warn'} />
          </div>
        </aside>
      </div>

      {/* ---- bottom ticker ---- */}
      <footer className="flex shrink-0 items-center gap-3 border-t border-ice/15 px-4 py-1.5">
        <span className="readout shrink-0 text-ice/45">LAST</span>
        <p className="readout truncate normal-case tracking-normal text-mist/60">
          {state.messages[state.messages.length - 1]?.text ?? 'Nothing said yet.'}
        </p>
      </footer>
    </div>
  );
}
