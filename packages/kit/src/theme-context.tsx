import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { type Scheme } from './tokens';
import {
  type ThemePreference,
  THEME_STORAGE_KEY,
  isThemePreference,
} from './theme';
import { type Palette, palette } from './palette';

interface ThemeContextValue {
  preference: ThemePreference;
  scheme: Scheme;
  palette: Palette;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemScheme(): Scheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function storedPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(raw) ? raw : 'system';
}

function useSystemScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(systemScheme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => { setScheme(mq.matches ? 'light' : 'dark'); };
    mq.addEventListener('change', onChange);
    return () => { mq.removeEventListener('change', onChange); };
  }, []);
  return scheme;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const system = useSystemScheme();
  const scheme: Scheme = preference === 'system' ? system : preference;

  const setPreference = (next: ThemePreference): void => {
    setPreferenceState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  };

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, scheme, palette: palette(scheme), setPreference }),
    [preference, scheme],
  );

  useEffect(() => {
    document.documentElement.style.colorScheme = scheme;
  }, [scheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

export function usePalette(): Palette {
  return useTheme().palette;
}
