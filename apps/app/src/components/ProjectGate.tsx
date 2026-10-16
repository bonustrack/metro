import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { PageTitle } from './PageTitle.js';
import { useHomeProject } from '../lib/agent-hooks.js';

interface ProjectGateProps {
  title: string;
  claudeProject: string | null;
  none: string;
  children: (picked: string) => ReactNode;
}

export function ProjectGate({ title, claudeProject, none, children }: ProjectGateProps): ReactNode {
  const home = useHomeProject();
  const picked = claudeProject ?? home.project;
  if (picked !== null) return children(picked);
  return (
    <Col gap={16}>
      <PageTitle>{title}</PageTitle>
      {home.loading ? <RowsSkeleton rows={4} leading={false} /> : <Text size="md" role="secondary">{none}</Text>}
    </Col>
  );
}
