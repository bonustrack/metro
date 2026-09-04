import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { KitThemeProvider, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { semanticPalette } from '@stage-labs/kit/tokens';
import { FONT_HEAD, FONT_SANS } from './theme';

export type ThemeMode = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

const STORAGE_KEY = 'metro.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

function isMode(value: string | null): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function storedMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isMode(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function storeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    return;
  }
}

function systemScheme(): Scheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function resolveScheme(mode: ThemeMode, system: Scheme): Scheme {
  return mode === 'system' ? system : mode;
}

function buildPalette(scheme: Scheme): KitPalette {
  const s = semanticPalette(scheme);
  return {
    bg: s.bgColor,
    border: s.borderColor,
    text: s.textColor,
    sub: s.subColor,
    link: s.linkColor,
    primary: s.primaryColor,
    danger: s.dangerColor,
    success: s.successColor,
    inputBg: s.inputBgColor,
    toolbarBg: s.toolbarBgColor,
  };
}

function applyCanvas(scheme: Scheme, palette: KitPalette): void {
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  root.style.backgroundColor = palette.bg;
  document.body.style.backgroundColor = palette.bg;
  const vars: Record<string, string> = {
    '--metro-bg': palette.bg,
    '--metro-text': palette.text,
    '--metro-sub': palette.sub,
    '--metro-heading': palette.link,
    '--metro-border': palette.border,
    '--metro-surface': palette.inputBg,
    '--metro-danger': palette.danger,
    '--metro-font-sans': FONT_SANS,
    '--metro-font-head': FONT_HEAD,
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

function applyFavicon(scheme: Scheme): void {
  document.querySelectorAll('link[rel="icon"]').forEach((link) => {
    const wantsDark = !(link.getAttribute('href') ?? '').includes('favicon-dark');
    link.setAttribute('media', wantsDark === (scheme === 'dark') ? 'all' : 'not all');
  });
}

interface ThemeModeValue {
  mode: ThemeMode;
  scheme: Scheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeValue | null>(null);

export function useThemeMode(): ThemeModeValue {
  const ctx = useContext(ThemeModeContext);
  if (ctx === null) throw new Error('useThemeMode used outside ThemeModeProvider');
  return ctx;
}

export function ThemeModeProvider({ children }: { children: ReactNode }): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [system, setSystem] = useState<Scheme>(systemScheme);

  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      setSystem(mq.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', onChange);
    onChange();
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, []);

  const scheme = resolveScheme(mode, system);
  const palette = buildPalette(scheme);

  useEffect(() => {
    applyCanvas(scheme, palette);
    applyFavicon(scheme);
  }, [scheme, palette]);

  const value = useMemo<ThemeModeValue>(
    () => ({
      mode,
      scheme,
      setMode: (next: ThemeMode) => {
        storeMode(next);
        setModeState(next);
      },
    }),
    [mode, scheme],
  );

  return (
    <ThemeModeContext.Provider value={value}>
      <KitThemeProvider value={palette} scheme={scheme}>
        {children}
      </KitThemeProvider>
    </ThemeModeContext.Provider>
  );
}
