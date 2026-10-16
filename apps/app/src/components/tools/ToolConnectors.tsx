import { Fragment, type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { activeAccount } from '@metro-labs/client/auth/account';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { connectorHost, connectorLabel } from '@metro-labs/client/api/connectors';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import type { Access } from '@metro-labs/client/api/policy';
import { routeHash } from '@metro-labs/client/route';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Loading } from '../Loading.js';
import { Modal } from '../Modal.js';
import { OrgConnectorPermissions } from '../OrgConnectorPermissions.js';
import { TextLink } from '../TextLink.js';
import { useAssignedConnectors } from '../AgentOrgConnectors.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { StateBlock } from '../ui/StateBlock.js';
import { technicalLine } from '../../lib/agent-line.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { go } from '../../lib/nav.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { connectorRule, exceptionsLabel, RULE_WORD, type ConnectorRule } from '../../lib/tools-view.js';
import { ICON_SIZE } from '../ui/sizes.js';

const TONE: Record<Access, 'success' | 'link' | 'danger'> = { allow: 'success', ask: 'link', deny: 'danger' };

function RuleLine({ rule }: { rule: ConnectorRule }): ReactNode {
  return (
    <>
      {rule.parts.map((part, at) => (
        <Fragment key={part.label}>
          {`${at === 0 ? '' : ' · '}${part.label} `}
          <Text size="xs" role={TONE[part.access]}>
            {RULE_WORD[part.access]}
          </Text>
        </Fragment>
      ))}
      {rule.exceptions === 0 ? null : ` · ${exceptionsLabel(rule.exceptions)}`}
    </>
  );
}

interface RowProps {
  connector: OrgConnector;
  peers: OrgConnector[];
  admin: boolean;
  onOpen: () => void;
}

function ConnectorRow({ connector, peers, admin, onOpen }: RowProps): ReactNode {
  const technical = useTechnicalDetails();
  const rule = connectorRule(connector, currentServer()?.id);
  const signedOut = admin ? 'Signed out. Sign in again on Connectors.' : 'Signed out. Ask an admin.';
  return (
    <Item
      title={connectorLabel(connector, peers)}
      subtitle={rule.signedOut ? signedOut : <RuleLine rule={rule} />}
      subtitleTone={rule.signedOut ? 'danger' : 'secondary'}
      detail={technical ? technicalLine([connectorHost(connector.url), connector.id]) : undefined}
      leading={<ConnectorFavicon name={connector.name} url={connector.url} size={ICON_SIZE.lg} radius={6} />}
      onPress={onOpen}
    />
  );
}

function RuleModal({ connector, peers, admin, onClose }: { connector: OrgConnector; peers: OrgConnector[]; admin: boolean; onClose: () => void }): ReactNode {
  const name = useAgentName();
  const agent = connector.agents.find((row) => row.id === currentServer()?.id);
  if (agent === undefined) return null;
  return (
    <Modal title={connectorLabel(connector, peers)} open onClose={onClose}>
      <Col gap={12}>
        <Text size="md" role="secondary">{`What ${name} may do here. The organization’s rule still applies, so this can only be stricter.`}</Text>
        <TextLink to={routeHash({ kind: 'org-connector', id: connector.id })}>Open it in Connectors</TextLink>
        <OrgConnectorPermissions connector={connector} agent={agent} admin={admin} title={`${name}’s rule`} />
      </Col>
    </Modal>
  );
}

function Body({ connectors, admin, first }: { connectors: OrgConnector[]; admin: boolean; first: string | null }): ReactNode {
  const name = useAgentName();
  const [open, setOpen] = useState<string | null>(first);
  const shown = connectors.find((row) => row.id === open);
  if (connectors.length === 0)
    return (
      <StateBlock
        icon="plug"
        title="No connector yet"
        text={`A connector gives ${name} tools, like a calendar, Notion or GitHub. An admin picks them on the Connectors page.`}
        action={{ label: 'Open Connectors', onPress: () => { go({ kind: 'org-connectors' }); } }}
      />
    );
  return (
    <>
      {connectors.map((row) => (
        <ConnectorRow key={row.id} connector={row} peers={connectors} admin={admin} onOpen={() => { setOpen(row.id); }} />
      ))}
      {shown === undefined ? null : <RuleModal connector={shown} peers={connectors} admin={admin} onClose={() => { setOpen(null); }} />}
    </>
  );
}

function Contents({ open }: { open: string | null }): ReactNode {
  const { connectors, admin, error } = useAssignedConnectors();
  if (connectors !== undefined) return <Body connectors={connectors} admin={admin} first={open} />;
  if (error !== null) return <StateBlock icon="exclamationCircle" danger title="Could not load the connectors" text={queryError(error, 'Try again in a moment.')} />;
  return <Loading />;
}

export function ToolConnectors({ open = null }: { open?: string | null }): ReactNode {
  const organization = activeAccount()?.organizationName ?? 'your organization';
  return (
    <Group label="Connectors" note={`From ${organization}. Admins pick who gets them.`}>
      <Contents open={open} />
    </Group>
  );
}
