import type {Mode} from '../hooks/useGrace.ts';

const CORE_ANIMATION: Record<Mode, string> = {
  offline: '',
  idle: 'orb-idle',
  waiting: 'orb-waiting',
  listening: 'orb-listening',
  thinking: 'orb-waiting',
  speaking: 'orb-speaking',
};

/** How lit the orb is in each state — dim when dormant, bright when engaged. */
const CORE_GLOW: Record<Mode, string> = {
  offline: 'from-slate-700/40 to-slate-900/10',
  idle: 'from-slate-500/40 to-slate-800/10',
  waiting: 'from-ice/40 to-ice/5',
  listening: 'from-ice/80 to-ice/10',
  thinking: 'from-ice/50 to-ice/5',
  speaking: 'from-ice/70 to-ice/10',
};

export function Orb({mode}: {mode: Mode}) {
  return (
    <div className="relative grid h-52 w-52 place-items-center">
      {/* Ripples out while she is taking something in. */}
      {mode === 'listening' && (
        <>
          <span className="orb-ring absolute h-36 w-36 rounded-full border border-ice/30" />
          <span
            className="orb-ring absolute h-36 w-36 rounded-full border border-ice/20"
            style={{animationDelay: '1.3s'}}
          />
        </>
      )}

      {/* A single arc turning, for the pause while she thinks. */}
      {mode === 'thinking' && (
        <span className="orb-spin absolute h-44 w-44 rounded-full border border-transparent border-t-ice/70 border-r-ice/20" />
      )}

      <span className="absolute h-40 w-40 rounded-full border border-edge/80" />

      <span
        className={`absolute h-32 w-32 rounded-full bg-gradient-to-b blur-xl ${CORE_GLOW[mode]} ${CORE_ANIMATION[mode]}`}
      />
      <span
        className={`absolute h-20 w-20 rounded-full bg-gradient-to-b ${CORE_GLOW[mode]} ${CORE_ANIMATION[mode]}`}
      />
      <span className="absolute h-3 w-3 rounded-full bg-slate-100/90 blur-[2px]" />
    </div>
  );
}
