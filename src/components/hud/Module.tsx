import {X} from 'lucide-react';
import type {ReactNode} from 'react';

/**
 * A panel that reads as a piece of equipment.
 *
 * The old layout was a sidebar and a column: correct, ordinary, and the same
 * shape as every web application. This is the other arrangement — instruments
 * arranged around the thing they are instruments for, each one labelled,
 * bounded and switched on rather than merely present.
 *
 * What makes it read that way is almost entirely restraint. One hairline
 * border, one small capitalised label, a translucent floor, and a corner mark
 * to break the rectangle. No shadows, no rounded softness, no gradients
 * inside the frame. Every one of those would make it a card again.
 *
 * Deliberately not draggable. Ada's windows drag because it is a desktop
 * application with a window manager of its own; this is one page in a
 * browser, and windows that can be dragged into a mess are windows somebody
 * has to tidy. The arrangement is fixed and considered instead.
 */

interface ModuleProps {
  label: string;
  children: ReactNode;
  /** A short status, shown at the right of the bar. Kept to a word or two. */
  status?: string;
  /** Amber rather than blue: something here wants attention. */
  warn?: boolean;
  onClose?: () => void;
  className?: string;
  /** Fills its container rather than sizing to content. */
  fill?: boolean;
}

export function Module({
  label,
  children,
  status,
  warn = false,
  onClose,
  className = '',
  fill = false,
}: ModuleProps) {
  return (
    <section
      className={`hairline relative flex min-h-0 flex-col bg-surface/55 ${
        fill ? 'h-full' : ''
      } ${className}`}>
      {/* The corner mark. Two short rules that overhang the frame, which is
          what stops the whole thing reading as a plain rectangle. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -left-px -top-px h-3 w-3 border-l border-t"
        style={{borderColor: 'rgb(var(--accent) / 0.55)'}}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-px -right-px h-3 w-3 border-b border-r"
        style={{borderColor: 'rgb(var(--accent) / 0.55)'}}
      />

      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ice/15 px-3 py-1.5">
        <span className="readout text-ice/70">{label}</span>
        <span className="flex items-center gap-2">
          {status && (
            <span className={`readout ${warn ? 'text-ember/90' : 'text-mist/50'}`}>
              {status}
            </span>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${label}`}
              className="text-mist/50 transition hover:text-ice">
              <X size={13} />
            </button>
          )}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">{children}</div>
    </section>
  );
}
