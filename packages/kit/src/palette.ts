import {
  type Scheme,
  colors,
  fontFamily,
  schemePalette,
  semanticPalette,
} from './tokens';

export interface Palette {
  scheme: Scheme;
  bg: string;
  toolbarBg: string;
  surface: string;
  hover: string;
  inputBg: string;
  border: string;
  head: string;
  text: string;
  sub: string;
  primary: string;
  onPrimary: string;
  danger: string;
  success: string;
  fontSans: string;
  fontHead: string;
  fontMono: string;
}

function fonts(family: readonly string[]): string {
  return family.join(', ');
}

export function palette(scheme: Scheme): Palette {
  const dark = scheme === 'dark';
  const p = schemePalette(dark);
  const s = semanticPalette(scheme);
  return {
    scheme,
    bg: s.bgColor,
    toolbarBg: s.toolbarBgColor,
    surface: dark ? colors['surface-dark'] : colors['surface-light'],
    hover: p.surface,
    inputBg: s.inputBgColor,
    border: p.border,
    head: p.head,
    text: p.text,
    sub: p.sub,
    primary: s.primaryColor,
    onPrimary: s.bgColor,
    danger: s.dangerColor,
    success: s.successColor,
    fontSans: fonts(fontFamily.sans),
    fontHead: fonts(fontFamily.head),
    fontMono: fonts(fontFamily.mono),
  };
}
