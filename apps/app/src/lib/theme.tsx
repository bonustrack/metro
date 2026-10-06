import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { KitThemeProvider, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { FONT_SIZE, semanticPalette } from '@stage-labs/kit/tokens';
import { resolveBadgeStyle, withAlpha } from '@stage-labs/kit/badge';
import { DROPDOWN_MENU } from '@stage-labs/kit/react-native/menu';
import { readItem, writeItem } from '@metro-labs/client/platform';
import { FONT_HEAD, FONT_SANS } from './style.js';

export type ThemeMode = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

const STORAGE_KEY = 'metro.theme';

export const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

const isMode = (value: string | null): value is ThemeMode => value === 'system' || value === 'light' || value === 'dark';

function storedMode(): ThemeMode {
  const raw = readItem(STORAGE_KEY);
  return isMode(raw) ? raw : 'system';
}

export function buildPalette(scheme: Scheme): KitPalette {
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

export const statusColor = (color: 'info' | 'success' | 'danger', scheme: Scheme): string => resolveBadgeStyle(color, undefined, undefined, scheme).background;

export const hoverColor = (palette: KitPalette): string => withAlpha(palette.link, DROPDOWN_MENU.hoverAlpha);

function cssVars(palette: KitPalette): Record<string, string> {
  const vars: Record<string, string> = {
    '--metro-bg': palette.bg,
    '--metro-text': palette.text,
    '--metro-sub': palette.sub,
    '--metro-heading': palette.link,
    '--metro-border': palette.border,
    '--metro-hover': hoverColor(palette),
    '--metro-surface': palette.inputBg,
    '--metro-toolbar': palette.toolbarBg,
    '--metro-danger': palette.danger,
    '--metro-success': palette.success,
    '--metro-font-sans': FONT_SANS,
    '--metro-font-head': FONT_HEAD,
  };
  for (const [name, size] of Object.entries(FONT_SIZE)) vars[`--kit-font-${name}`] = `${String(size)}px`;
  return vars;
}

function paintDocument(scheme: Scheme, palette: KitPalette): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  root.style.backgroundColor = palette.bg;
  document.body.style.backgroundColor = palette.bg;
  for (const [name, value] of Object.entries(cssVars(palette))) root.style.setProperty(name, value);
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
  const system: Scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const scheme: Scheme = mode === 'system' ? system : mode;
  const palette = useMemo(() => buildPalette(scheme), [scheme]);

  useEffect(() => {
    paintDocument(scheme, palette);
  }, [scheme, palette]);

  const value = useMemo<ThemeModeValue>(
    () => ({
      mode,
      scheme,
      setMode: (next: ThemeMode) => {
        writeItem(STORAGE_KEY, next);
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
