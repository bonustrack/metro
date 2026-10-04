import { type ReactNode } from 'react';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { Pending } from './Pending.js';

export function LaunchServer({ onLock }: { onLock: () => void }): ReactNode {
  return (
    <Frame sidebar={(closeMenu) => <PlainSidebar selection={{ kind: 'servers' }} onSelect={closeMenu} />} onLock={onLock}>
      <Pending title="New agent" />
    </Frame>
  );
}
