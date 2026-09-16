import {useEffect, useRef} from 'react';

/**
 * The small instruments the panel is made of.
 *
 * One rule runs through all of them: nothing here is decoration. Every bar is
 * a real quantity, every figure is read from something, and anything that
 * cannot be filled with a true value is not drawn. A panel full of invented
 * telemetry looks exactly like a panel full of real telemetry, which is what
 * makes fake readouts worse than no readouts — you cannot tell by looking
 * which kind you have, so you end up trusting neither.
 */

/** A labelled bar. `of` is the full scale; `value` is where the needle sits. */
export function Gauge({
  label,
  value,
  of = 1,
  shown,
  warn = false,
}: {
  label: string;
  value: number;
  of?: number;
  /** What to print at the right. The raw number, unless it needs units. */
  shown?: string;
  warn?: boolean;
}) {
  const share = of > 0 ? Math.max(0, Math.min(1, value / of)) : 0;
  const colour = warn ? 'var(--color-ember)' : 'rgb(var(--accent))';

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="readout text-mist/55">{label}</span>
        <span
          className="readout tabular-nums"
          style={{color: warn ? 'var(--color-ember)' : 'rgb(var(--accent) / 0.85)'}}>
          {shown ?? value.toFixed(2)}
        </span>
      </div>
      <div className="h-[3px] w-full bg-ice/10">
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{width: `${share * 100}%`, background: colour}}
        />
      </div>
    </div>
  );
}

/** A line of the session readout: name on the left, value on the right. */
export function Field({label, value}: {label: string; value: string}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="readout shrink-0 text-mist/45">{label}</span>
      <span className="readout truncate text-right text-ice/75" title={value}>
        {value}
      </span>
    </div>
  );
}

/**
 * The microphone, as a polar plot.
 *
 * A bar meter tells you the level now. This keeps the last couple of seconds
 * as a ring, so you can see the shape of what you just said — which is the
 * difference between "the microphone is working" and "it heard *that*". When
 * a room is too quiet or a microphone is half-broken, the ring is visibly
 * lopsided rather than merely low.
 *
 * Drawn on a canvas, reading the level from a ref, for the reason Ada does
 * the same: the level changes tens of times a second, and putting that
 * through React would re-render the page at audio rate. The canvas redraws
 * itself and nothing above it ever knows.
 */
export function Polar({level, live, size = 132}: {level: number; live: boolean; size?: number}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  const liveRef = useRef(live);

  useEffect(() => {
    levelRef.current = level;
    liveRef.current = live;
  }, [level, live]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Drawn at the screen's real pixel density. Without this the whole thing
    // is soft on any laptop made in the last decade, which reads as cheap in
    // a way that is hard to point at.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const SPOKES = 36;
    const history = new Array<number>(SPOKES).fill(0);
    let at = 0;
    let frame = 0;
    let stop = false;

    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent')
      .trim() || '76 215 255';

    const draw = () => {
      if (stop) return;
      frame += 1;
      const mid = size / 2;
      const max = mid - 10;

      // One spoke every few frames rather than every frame: the ring should
      // turn at about one revolution per two seconds, not per third of one.
      if (frame % 3 === 0) {
        history[at] = Math.min(1, levelRef.current * 1.6);
        at = (at + 1) % SPOKES;
      }

      ctx.clearRect(0, 0, size, size);

      // Reference rings, so a reading has something to be read against.
      ctx.strokeStyle = `rgb(${accent} / 0.12)`;
      ctx.lineWidth = 1;
      for (const ring of [0.35, 0.7, 1]) {
        ctx.beginPath();
        ctx.arc(mid, mid, max * ring, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.beginPath();
      for (let i = 0; i < SPOKES; i += 1) {
        // Read starting from the oldest, so the shape rotates rather than
        // flickering as the write cursor wraps around.
        const sample = history[(at + i) % SPOKES] ?? 0;
        const angle = (i / SPOKES) * Math.PI * 2 - Math.PI / 2;
        const reach = 6 + sample * max;
        const x = mid + Math.cos(angle) * reach;
        const y = mid + Math.sin(angle) * reach;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgb(${accent} / ${liveRef.current ? 0.85 : 0.3})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = `rgb(${accent} / ${liveRef.current ? 0.14 : 0.05})`;
      ctx.fill();

      requestAnimationFrame(draw);
    };

    draw();
    return () => {
      stop = true;
    };
  }, [size]);

  return <canvas ref={canvasRef} style={{width: size, height: size}} aria-hidden />;
}


/** A section rule with its label sitting on it. */
export function Head({children}: {children: React.ReactNode}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="readout whitespace-nowrap text-ice/55">{children}</span>
      <span className="h-px flex-1 bg-ice/15" />
    </div>
  );
}

/**
 * One row of a column: label, optional bar, value.
 *
 * `tone` is not styling for its own sake. Green means running, amber means
 * something wants you, cyan is everything else — and because those meanings
 * never vary, a glance down the column says whether anything is wrong without
 * a single word being read. A palette where the colours mean nothing in
 * particular is a palette you have to read, which defeats the point of having
 * a panel at all.
 */
export function Row({
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
        <span className="readout shrink-0 truncate tabular-nums" style={{color: colour}} title={value}>
          {value}
        </span>
      </div>
      {share !== undefined && (
        /*
         * The track is always drawn, and the fill has a floor.
         *
         * A bar at zero with no track is invisible, so a column of them at
         * rest looked like a column of plain text — the panel only became a
         * panel once something happened. The floor means a real zero still
         * shows a lit sliver, which reads as "measured and currently nothing"
         * rather than as "not wired up".
         */
        <div className="mt-1 h-[2px] w-full bg-ice/[0.08]">
          <div
            className="h-full transition-[width] duration-700 ease-out"
            style={{
              width: `${Math.max(1.5, Math.min(1, share) * 100)}%`,
              background: colour,
              opacity: share <= 0 ? 0.35 : 1,
            }}
          />
        </div>
      )}
    </div>
  );
}
