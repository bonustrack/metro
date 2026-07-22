import { type CSSProperties, type ReactNode } from 'react';
import { usePalette } from '../theme-context';

interface CardProps {
  padding?: number;
  style?: CSSProperties;
  children: ReactNode;
}

export function Card({ padding = 16, style, children }: CardProps): ReactNode {
  const p = usePalette();
  return (
    <div
      style={{
        background: p.bg,
        border: `1px solid ${p.border}`,
        borderRadius: 12,
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
