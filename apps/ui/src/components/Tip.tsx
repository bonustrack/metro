import { type ReactNode } from 'react';

const TIP_TEXT = { fontSize: 17, lineHeight: '20px' } as const;

export function Tip({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <span className="tip-host">
      {children}
      <span className="tip" aria-hidden="true">
        <span className="tip-label" style={TIP_TEXT}>
          {label}
        </span>
      </span>
    </span>
  );
}
