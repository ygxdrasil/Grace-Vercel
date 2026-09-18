import {useEffect, useRef, useState} from 'react';

/**
 * The moment she comes up.
 *
 * A brief cinematic on the first open of a session — a line drawing itself,
 * her name resolving — then gone. Once per session, skippable by a tap, and
 * absent entirely for anyone who has asked for less motion, because a boot
 * sequence you cannot skip is a boot sequence you come to hate.
 */

export function Boot({onDone}: {onDone: () => void}) {
  const [leaving, setLeaving] = useState(false);

  /*
   * Held in a ref, and the timers set once.
   *
   * The caller passes a new function every render, so depending on it here
   * meant the effect tore down and started again every time anything on the
   * panel moved — and something on the panel moves every second. Both timers
   * were restarted before either could fire, so the splash never left of its
   * own accord: it stayed over the whole screen, at full opacity, swallowing
   * every click. A button that cannot be pressed is indistinguishable from an
   * assistant that cannot hear you.
   */
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hold = reduce ? 200 : 2100;
    const fade = window.setTimeout(() => setLeaving(true), hold);
    const gone = window.setTimeout(() => doneRef.current(), hold + 500);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, []);

  return (
    <div
      onClick={() => doneRef.current()}
      className={`fixed inset-0 z-[80] grid place-items-center bg-void transition-opacity duration-500 ${
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}>
      <div className="field pointer-events-none opacity-60" />
      <div className="text-center">
        <svg width="220" height="60" viewBox="0 0 220 60" className="mx-auto">
          {/* A line that draws itself across, then settles under the name. */}
          <line
            x1="10"
            y1="30"
            x2="210"
            y2="30"
            stroke="rgb(var(--accent))"
            strokeWidth="1.5"
            strokeDasharray="200"
            strokeDashoffset="200"
            opacity="0.6"
            style={{animation: 'bootline 1.4s ease-out forwards'}}
          />
        </svg>
        <p
          className="font-serif text-5xl tracking-[0.2em] text-slate-100"
          style={{animation: 'bootname 1.6s ease-out both'}}>
          GRACE
        </p>
        <p
          className="mt-3 text-[0.6rem] uppercase tracking-[0.4em] text-mist/40"
          style={{animation: 'bootname 1.6s ease-out 0.4s both'}}>
          at your service
        </p>
      </div>
    </div>
  );
}
