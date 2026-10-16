import { type ReactNode } from 'react';
import { View } from 'react-native';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { Groups } from '../ui/Group.js';
import { Routines } from './Routines.js';
import { SecretKeys } from './SecretKeys.js';
import { ToolConnectors } from './ToolConnectors.js';
import { useConnectorScope } from '../../lib/org-connector-queries.js';
import { useScrollToAnchor } from '../../lib/scroll-anchor.js';
import { webOnly } from '../../lib/style.js';
import { useDocumentTitle } from '../../lib/title.js';

type ToolsFocus = 'routines' | 'secret-keys';

const ANCHOR = webOnly({ scrollMarginTop: 180 });

interface ToolsPageProps {
  project: string;
  focus?: ToolsFocus | null;
}

export function ToolsPage({ project, focus = null }: ToolsPageProps): ReactNode {
  const scope = useConnectorScope();
  useDocumentTitle('Tools');
  useScrollToAnchor(focus);
  return (
    <Groups>
      <ToolConnectors key={`${String(scope)}:${currentServer()?.id ?? ''}`} project={project} />
      <View nativeID="routines" style={ANCHOR}>
        <Routines project={project} />
      </View>
      <View nativeID="secret-keys" style={ANCHOR}>
        <SecretKeys />
      </View>
    </Groups>
  );
}
