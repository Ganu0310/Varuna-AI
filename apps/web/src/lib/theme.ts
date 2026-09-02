import { useCallback, useEffect, useState } from 'react';

/**
 * The theme, applied at the document root so every route gets it.
 *
 * It used to live inside `AppChrome`, which meant `/login` and `/register` — the only screens
 * that render WITHOUT the chrome — never had `data-theme` set at all. They were stuck dark
 * regardless of the preference, and switching to light after signing in produced a jarring
 * flip back on sign-out. The state belongs to the document, not to one component.
 *
 * Storage is wrapped because access itself throws in some contexts (a private window, a
 * browser set to block site data), not merely writes. A remembered preference is a
 * convenience; failing to read one must never stop the app rendering.
 */

export type Theme = 'dark' | 'light';

const KEY = 'varuna.theme';

export function readTheme(): Theme {
  try {
    return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    /* preference not remembered; the current session still honours it */
  }
}

/** Read once, apply on change, and hand back a toggle. Safe to call from several components. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Other components using this hook hold their own copy of the state, so a change made in
  // one must be observable in the others. The storage event covers other tabs; this covers
  // this one.
  useEffect(() => {
    const onChange = () => setTheme(readTheme());
    window.addEventListener('varuna:theme', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('varuna:theme', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      window.dispatchEvent(new Event('varuna:theme'));
      return next;
    });
  }, []);

  return { theme, toggle };
}
