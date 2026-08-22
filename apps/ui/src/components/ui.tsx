import { type ReactElement } from 'react';
import { FONT_SIZE } from '@stage-labs/kit/tokens';
import {
  Button as KitButton,
  type ButtonProps,
  type ButtonSize,
} from '@stage-labs/kit/react-native/button';
import { Text as KitText, type TextProps } from '@stage-labs/kit/react-native/text';
import { Input as KitInput, type InputProps } from '@stage-labs/kit/react-native/input';
import {
  FONT_HEAD,
  FONT_SANS,
  TEXT_FONT,
  textSize,
  typeSize,
} from '../theme';

const BUTTON_FONT_SIZE: Record<ButtonSize, number> = {
  '3xs': FONT_SIZE['3xs'],
  '2xs': FONT_SIZE['2xs'],
  xs: FONT_SIZE['2xs'],
  sm: FONT_SIZE.xs,
  md: FONT_SIZE.sm,
  lg: FONT_SIZE.md,
  xl: FONT_SIZE.md,
  '2xl': FONT_SIZE.lg,
  '3xl': FONT_SIZE['2xl'],
};

export function Text({ style, ...props }: TextProps): ReactElement {
  const base = {
    fontSize: textSize(props.size, props.variant),
    fontFamily: TEXT_FONT[props.weight ?? 'normal'],
  };
  const merged =
    style === undefined ? base : [base, ...(Array.isArray(style) ? style : [style])];
  return <KitText {...props} style={merged} />;
}

export function Button({ textStyle, ...props }: ButtonProps): ReactElement {
  const fontSize = typeSize(BUTTON_FONT_SIZE[props.size ?? 'md']);
  const merged = { fontFamily: FONT_HEAD, fontSize, ...textStyle };
  return <KitButton {...props} textStyle={merged} />;
}

export function Input({ style, ...props }: InputProps): ReactElement {
  const base = {
    fontFamily: FONT_SANS,
    fontSize: typeSize(FONT_SIZE.md),
    borderWidth: 0,
  };
  return <KitInput {...props} style={style === undefined ? base : [base, style]} />;
}
