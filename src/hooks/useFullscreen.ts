import {useCallback, useEffect, useState} from 'react';

/**
 * F, for the whole screen.
 *
 * The panel is meant to be looked at across a room, and a browser's chrome
 * around it — tabs, an address bar, a bookmark strip — is the one part of it
 * nobody designed. One key is the right size of gesture for that: no modifier
 * to remember, and the same key again to come back.
 *
 * Two things this has to get right, and both are about not being in the way.
 *
 * A bare letter is a dangerous shortcut, because most of the time a letter is
 * somebody typing. So it is ignored whenever anything is focused that takes
 * text — the composer, the palette, a settings field — and whenever a modifier
 * is held, since Ctrl+F is the browser's and stealing it would be rude.
 *
 * And the state is read from the document rather than remembered. Fullscreen
 * can end without anyone pressing F — Escape does it, and so does the browser
 * on its own — so a boolean kept here would drift out of step and leave the
 * key doing the opposite of what it says.
 */

function typing(): boolean {
  const focused = document.activeElement as HTMLElement | null;
  if (!focused) return false;
  if (focused.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName);
}

export function useFullscreen(): {full: boolean; toggle: () => void} {
  const [full, setFull] = useState(false);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    // Refused when it was not asked for by a real gesture, and on iPhones
    // where the whole API is absent. Neither is worth an error on screen —
    // the key simply does nothing, which is what the browser has decided.
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const changed = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);

    const key = (event: KeyboardEvent) => {
      if (event.key !== 'f' && event.key !== 'F') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing()) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', key);

    changed();
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('keydown', key);
    };
  }, [toggle]);

  return {full, toggle};
}
