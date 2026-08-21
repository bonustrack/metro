import { FONT_SIZE, type FontSizeName } from '@stage-labs/kit/tokens';
import { type TextVariant, type TextWeight } from '@stage-labs/kit/react-native/text';

const SYSTEM_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const FONT_SANS = `Calibre-Medium, ${SYSTEM_SANS}`;
export const FONT_HEAD = `Calibre-Semibold, ${SYSTEM_SANS}`;
export const FONT_MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const TEXT_FONT: Record<TextWeight, string> = {
  normal: FONT_SANS,
  regular: FONT_SANS,
  medium: FONT_SANS,
  semibold: FONT_HEAD,
  bold: FONT_HEAD,
};

export const TYPE_SCALE = 16 / 15;

export function typeSize(px: number): number {
  return Math.round(px * TYPE_SCALE);
}

export function textSize(
  size: FontSizeName | undefined,
  variant: TextVariant | undefined,
): number {
  if (size !== undefined) return typeSize(FONT_SIZE[size]);
  return typeSize(variant === 'caption' ? FONT_SIZE.xs : FONT_SIZE.md);
}


export const SHRINK = { flexShrink: 1, minWidth: 0 } as const;

export const GROW = { flexGrow: 1, minWidth: 0 } as const;
