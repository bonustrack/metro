import { type ReactNode } from 'react';
import { Tooltip } from '@stage-labs/kit/react-native/tooltip';

export function Tip({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <span className="tip-host">
      {children}
      <span className="tip" aria-hidden="true">
        <Tooltip label={label} arrow="down" />
      </span>
    </span>
  );
}
