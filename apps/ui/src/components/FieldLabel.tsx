import { type ReactNode } from 'react';
import { Text } from './ui.js';
import { SMALL_FONT_SIZE, typeSize } from '../theme.js';

const LABEL_STYLE = {
  textTransform: 'uppercase',
  letterSpacing: 1.2,
  fontSize: typeSize(SMALL_FONT_SIZE['2xs']),
} as const;

export function FieldLabel({ children }: { children: string }): ReactNode {
  return (
    <Text role="secondary" style={LABEL_STYLE}>
      {children}
    </Text>
  );
}
