import type {Mode} from '../hooks/useGrace.ts';

/**
 * Her, as an instrument rather than a bubble.
 *
 * The brief was the Stark feeling without the cost of it: no volumetric
 * brain, no WebGL, nothing that makes a laptop fan audible for a thing that
 * sits on screen all day. So everything here is rings, and every ring moves
 * by `transform` and `opacity` alone.
 *
 * That constraint is doing real work. Those two properties are the only ones
 * a browser can animate on the compositor, without laying the page out again
 * or repainting a pixel — which is the difference between an idle animation
 * costing nothing and costing a core. Animating width, or a box-shadow, or a
 * backdrop blur would look almost identical and would make this the most
 * expensive thing on the machine.
 *
 * The rings are deliberately not decoration. Each one says something:
 *
 *   outer      how alert she is — still when idle, turning when engaged
 *   ticks      a dial, so movement is readable rather than merely present
 *   inner      counter-rotating, which is what stops it reading as a spinner
 *   iris       your voice, live, swelling as you speak
 *   core       lit when she is listening or talking, banked when she is not
 */

interface ReactorProps {
  mode: Mode;
  /** Live input level, 0 to 1. */
  level?: number;
  onPress?: () => void;
  busy?: boolean;
  /** Bigger, for across the room. */
  size?: 'normal' | 'stage';
}

/** How fast the outer ring turns in each state, in seconds per revolution. */
const PACE: Record<Mode, number> = {
  offline: 0,
  idle: 46,
  waiting: 26,
  listening: 11,
  thinking: 5.5,
  speaking: 14,
};

/** How lit she is. Banked when dormant; never fully dark unless offline. */
const LIT: Record<Mode, number> = {
  offline: 0.06,
  idle: 0.3,
  waiting: 0.48,
  listening: 0.95,
  thinking: 0.7,
  speaking: 0.85,
};

/**
 * The dial marks, drawn once as a repeating gradient rather than as sixty
 * elements. Sixty divs would each be laid out and composited; this is one
 * painted surface that only ever rotates.
 */
function ticks(count: number, thickness: number): string {
  const slice = 360 / count;
  return `repeating-conic-gradient(from 0deg, currentColor 0deg ${thickness}deg, transparent ${thickness}deg ${slice}deg)`;
}

export function Reactor({
  mode,
  level = 0,
  onPress,
  busy = false,
  size = 'normal',
}: ReactorProps) {
  const span = size === 'stage' ? 'h-72 w-72' : 'h-52 w-52';
  const lit = LIT[mode];
  const pace = PACE[mode];

  // Damped and capped. The iris follows your voice, and a single loud sample
  // must not make it lurch — the point is to show she is hearing you, not to
  // be an accurate meter.
  const swell = 1 + Math.min(0.3, level * 0.55);

  const body = (
    <div className={`relative grid ${span} place-items-center`} aria-hidden>
      {/* The outermost ring: a broken circle, so that rotation is visible. */}
      <span
        className="absolute inset-0 rounded-full border border-ice/25"
        style={{
          animation: pace ? `reactorSpin ${pace}s linear infinite` : undefined,
          clipPath:
            'polygon(0 0, 100% 0, 100% 34%, 96% 34%, 96% 66%, 100% 66%, 100% 100%, 0 100%, 0 66%, 4% 66%, 4% 34%, 0 34%)',
          opacity: lit + 0.12,
        }}
      />

      {/* The dial. Turns the other way, slowly, so the two never sync up. */}
      <span
        className="absolute rounded-full text-ice/35"
        style={{
          inset: '11%',
          background: ticks(60, 0.7),
          WebkitMaskImage: 'radial-gradient(circle, transparent 93%, #000 93%)',
          maskImage: 'radial-gradient(circle, transparent 93%, #000 93%)',
          animation: pace ? `reactorSpin ${pace * 2.6}s linear infinite reverse` : undefined,
          opacity: lit,
        }}
      />

      {/* Inner armature: counter-rotating, which is what reads as machinery
          rather than as a loading spinner. */}
      <span
        className="absolute rounded-full border border-ice/30"
        style={{
          inset: '22%',
          animation: pace ? `reactorSpin ${pace * 0.62}s linear infinite reverse` : undefined,
          clipPath: 'polygon(50% 0, 100% 0, 100% 100%, 50% 100%)',
          opacity: lit,
        }}
      />
      <span
        className="absolute rounded-full border border-ice/20"
        style={{
          inset: '30%',
          animation: pace ? `reactorSpin ${pace * 0.9}s linear infinite` : undefined,
          clipPath: 'polygon(0 0, 50% 0, 50% 100%, 0 100%)',
          opacity: lit,
        }}
      />

      {/* The iris. Follows your voice while she is listening, breathes
          otherwise. This is the only thing on screen that reacts in real
          time, which is what makes it obvious she can hear you. */}
      <span
        className="absolute rounded-full"
        style={{
          inset: '38%',
          background:
            'radial-gradient(circle at 50% 50%, rgb(var(--accent) / 0.55), rgb(var(--accent) / 0.05) 70%)',
          transform: `scale(${swell})`,
          // No transition while listening: the whole point is that it tracks
          // your voice. A transition would smooth away the thing it is for.
          transition: mode === 'listening' ? undefined : 'transform 700ms ease-out',
          opacity: lit,
        }}
      />

      {/* The core. Small, bright, and the only filled shape here. */}
      <span
        className="absolute rounded-full bg-ice"
        style={{
          inset: '46%',
          opacity: Math.min(1, lit + 0.2),
          boxShadow: `0 0 ${size === 'stage' ? 40 : 26}px rgb(var(--accent) / ${lit * 0.55})`,
          animation:
            mode === 'thinking' || mode === 'speaking'
              ? 'reactorPulse 1.6s ease-in-out infinite'
              : undefined,
        }}
      />
    </div>
  );

  if (!onPress) return body;

  return (
    <button
      type="button"
      onClick={onPress}
      disabled={busy}
      // Named for what it does rather than what it looks like, because this is
      // the one control on the screen and a screen reader gets no help at all
      // from being told there is a circle.
      aria-label="Talk to Grace"
      className="rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ice/60 active:scale-[0.98] disabled:opacity-60"
    >
      {body}
    </button>
  );
}
