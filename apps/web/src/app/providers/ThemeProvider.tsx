import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Theme control — 04_UIUX §4.2. Dark is the primary operational theme; light is a
 * deliberately designed alternative (not an inversion) and `system` follows the OS.
 *
 * The choice is written to `document.documentElement[data-theme]` and persisted in
 * localStorage under `varuna.theme`. index.html applies the same value before first paint
 * so there is no flash. The report route scopes its own light tokens via `.report` and is
 * unaffected by this.
 */
export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'varuna.theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* private mode / storage disabled — fall through to the default */
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStored);
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(systemTheme);

  // Track the OS setting only while the preference is `system`.
  useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystemResolved(mq.matches ? 'light' : 'dark');
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  const resolved: ResolvedTheme = preference === 'system' ? systemResolved : preference;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* nothing we can do; the in-memory choice still applies for this session */
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Falls back to an inert `system` value when no provider is mounted (isolated component
 * tests, Storybook), rather than throwing — the toggle simply renders in its default state.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  return { preference: 'system', resolved: 'dark', setPreference: () => {} };
}
