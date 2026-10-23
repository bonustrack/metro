import { type ReactNode } from 'react';
import { Routines } from './Routines.js';
import { useDocumentTitle } from '../../lib/title.js';

export function ScheduledPage({ project }: { project: string }): ReactNode {
  useDocumentTitle('Scheduled');
  return <Routines project={project} />;
}
