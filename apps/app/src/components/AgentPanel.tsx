import { type ReactNode } from 'react';
import { type Selection } from '@metro-labs/client/selection';
import { Pending } from './Pending.js';
import { sectionOf } from './sections.js';

export function AgentPanel({ selection }: { selection: Selection }): ReactNode {
  return <Pending title={sectionOf(selection.kind)?.label ?? 'Agent'} />;
}
