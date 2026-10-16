import { useEffect, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { KitThemeProvider, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { semanticPalette } from '@stage-labs/kit/tokens';
import { withAlpha } from '@stage-labs/kit/badge';
import { DROPDOWN_MENU } from '@stage-labs/kit/react-native/menu';

type Scheme = 'light' | 'dark';

const SCHEME: Scheme = 'dark';

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

export const hoverColor = (palette: KitPalette): string => withAlpha(palette.link, DROPDOWN_MENU.hoverAlpha);

const FILL_ALPHA = 0.16;
const SHAPE_ALPHA = 0.08;

export const fillColor = (color: string): string => withAlpha(color, FILL_ALPHA);

export const shapeColor = (palette: KitPalette): string => withAlpha(palette.link, SHAPE_ALPHA);

const SELECTED_ALPHA = 0.05;
const HEX = /^#[0-9a-fA-F]{6}$/;

const channels = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

function blend(top: string, bottom: string, alpha: number): string {
  if (!HEX.test(top) || !HEX.test(bottom)) return withAlpha(top, alpha);
  const under = channels(bottom);
  const mixed = channels(top).map((c, i) => Math.round(c * alpha + (under[i] ?? 0) * (1 - alpha)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export const selectedColor = (palette: KitPalette): string => blend(palette.link, palette.bg, SELECTED_ALPHA);

function cssVars(palette: KitPalette): Record<string, string> {
  return { '--metro-bg': palette.bg, '--metro-border': palette.border };
}

function paintDocument(scheme: Scheme, palette: KitPalette): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  root.style.backgroundColor = palette.bg;
  document.body.style.backgroundColor = palette.bg;
  for (const [name, value] of Object.entries(cssVars(palette))) root.style.setProperty(name, value);
}

const PALETTE = buildPalette(SCHEME);

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  useEffect(() => {
    paintDocument(SCHEME, PALETTE);
  }, []);
  return (
    <KitThemeProvider value={PALETTE} scheme={SCHEME}>
      {children}
    </KitThemeProvider>
  );
}
