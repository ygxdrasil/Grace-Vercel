import {useEffect, useRef} from 'react';

/**
 * The thing in the middle.
 *
 * A cloud of points on a slowly turning sphere, ringed by broken arcs. It is
 * doing the job a face does on a person: you look at it to see whether
 * anything is happening, and you look away again. Everything precise lives in
 * the columns either side.
 *
 * Deliberately not WebGL and deliberately not a real 3D scene. Three hundred
 * dots projected by hand onto a 2D canvas costs a fraction of a millisecond a
 * frame and runs identically on a laptop with no graphics card — which was
 * the whole objection to a volumetric brain, and the objection was right. The
 * sphere reads as depth because of size and brightness falling off with
 * distance, which is all depth ever is on a flat screen.
 */

interface CoreProps {
  /** 0 to 1. Swells the cloud and brightens it. */
  level?: number;
  /** Faster rotation and a brighter core while she is doing something. */
  active?: boolean;
  size?: number;
}

export function Core({level = 0, active = false, size = 420}: CoreProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  const activeRef = useRef(active);

  useEffect(() => {
    levelRef.current = level;
    activeRef.current = active;
  }, [level, active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    /*
     * Points spread evenly over a sphere by the golden angle.
     *
     * Random points clump — the eye is very good at spotting the clumps, and
     * a clumped cloud reads as a mistake rather than as a texture. This lays
     * them down in a spiral that never repeats, which looks deliberate
     * because it is.
     */
    const COUNT = 520;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const points = Array.from({length: COUNT}, (_, i) => {
      const y = 1 - (i / (COUNT - 1)) * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      return {
        x: Math.cos(theta) * radius,
        y,
        z: Math.sin(theta) * radius,
        // A little variation so the shell has thickness rather than being a
        // hollow ball with every dot at exactly the same distance.
        shell: 0.55 + Math.random() * 0.45,
      };
    });

    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() ||
      '76 215 255';

    let turn = 0;
    let stop = false;

    const draw = () => {
      if (stop) return;
      const mid = size / 2;
      const loud = levelRef.current;
      const hot = activeRef.current;
      const span = mid * 0.52 * (1 + loud * 0.16);

      turn += hot ? 0.0022 : 0.0009;

      ctx.clearRect(0, 0, size, size);

      // The haze the cloud sits in, so the middle reads as lit rather than as
      // a gap between dots.
      const haze = ctx.createRadialGradient(mid, mid, 0, mid, mid, span * 1.5);
      haze.addColorStop(0, `rgb(${accent} / ${0.2 + loud * 0.14})`);
      haze.addColorStop(1, `rgb(${accent} / 0)`);
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, size, size);

      const sin = Math.sin(turn);
      const cos = Math.cos(turn);

      for (const point of points) {
        // One rotation about the vertical. A second axis looks busier and
        // makes the cloud harder to read as a sphere, not easier.
        const x = point.x * cos - point.z * sin;
        const z = point.x * sin + point.z * cos;

        const depth = (z + 1) / 2;
        const px = mid + x * span * point.shell;
        const py = mid + point.y * span * point.shell;

        ctx.beginPath();
        ctx.arc(px, py, 0.55 + depth * 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${accent} / ${(0.18 + depth * 0.78) * (hot ? 1 : 0.85)})`;
        ctx.fill();
      }

      requestAnimationFrame(draw);
    };

    draw();
    return () => {
      stop = true;
    };
  }, [size]);

  /** One broken ring. Gaps are what make rotation visible at all. */
  const ring = (inset: string, seconds: number, reverse: boolean, opacity: number) => (
    <span
      key={inset}
      aria-hidden
      className="pointer-events-none absolute rounded-full border-[1.5px] border-ice"
      style={{
        inset,
        opacity,
        animation: `reactorSpin ${seconds}s linear infinite${reverse ? ' reverse' : ''}`,
        clipPath:
          'polygon(0 0, 100% 0, 100% 30%, 97% 30%, 97% 70%, 100% 70%, 100% 100%, 0 100%, 0 70%, 3% 70%, 3% 30%, 0 30%)',
      }}
    />
  );

  return (
    <div className="relative grid place-items-center" style={{width: size, height: size}}>
      {ring('0%', 64, false, 0.55)}
      {ring('7%', 44, true, 0.34)}
      {ring('15%', 96, false, 0.4)}
      <canvas ref={canvasRef} style={{width: size, height: size}} aria-hidden />
    </div>
  );
}
