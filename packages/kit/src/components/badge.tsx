import { type ReactNode } from 'react';
import { FONT_SIZE } from '../tokens';
import { usePalette } from '../theme-context';

interface BadgeProps {
  children: ReactNode;
}

export function Badge({ children }: BadgeProps): ReactNode {
  const p = usePalette();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 10px',
        borderRadius: 999,
        background: p.inputBg,
        border: `1px solid ${p.border}`,
        color: p.sub,
        fontFamily: p.fontSans,
        fontWeight: 500,
        fontSize: FONT_SIZE['2xs'],
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
