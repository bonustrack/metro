import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { useHomeProject } from './home-project.js';

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
      {home.loading ? <Loading /> : <Text size="sm" role="secondary">{none}</Text>}
    </Col>
  );
}
