import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { AgentAvatar } from './AgentAvatar';
import { DeleteAgent } from './DeleteAgent';
import { opensElsewhere } from './link';
import { type AgentSummary } from '../api/client';
import { routeHash } from '../route';

const ROW_PAD_Y = 12;
const AVATAR_SIZE = 16;
const DOT_SIZE = 8;

function liveness(agent: AgentSummary): string | null {
  if (!agent.owned || agent.connected) return null;
  if (agent.runtime !== null) return null;
  return agent.lastSeen === null ? null : 'not receiving';
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

function summary(agent: AgentSummary, stations: number): string {
  const held = plural(agent.connectorIds.length, 'connector');
  const label = `${plural(stations, 'station')} · ${held}`;
  return agent.owned ? label : `${label} · not owned`;
}

interface AgentRowProps {
  agent: AgentSummary;
  project: string;
  stations: number;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function AgentRow({
  agent,
  project,
  stations,
  onOpen,
  onDelete,
}: AgentRowProps): ReactNode {
  const palette = useKitPalette();
  const offline = liveness(agent);
  return (
    <Row
      justify="between"
      align="stretch"
      gap={12}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <a
        className="row-link"
        href={routeHash({ kind: 'agent', project, id: agent.id })}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen(agent.id);
        }}
      >
        <AgentAvatar seed={agent.id} size={AVATAR_SIZE} />
        <Row
          gap={10}
          align="center"
          flex={1}
          minWidth={0}
          padding={{ y: ROW_PAD_Y }}
        >
          <span className="row-title">
            <Text size="lg" weight="semibold" numberOfLines={1}>
              {agent.name}
            </Text>
          </span>
          <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
            {summary(agent, stations)}
          </Text>
          {agent.owned && agent.connected ? (
            <Row
              width={DOT_SIZE}
              height={DOT_SIZE}
              radius={DOT_SIZE}
              background={palette.success}
            />
          ) : null}
          {offline === null ? null : (
            <Text size="sm" role="danger" numberOfLines={1}>
              {offline}
            </Text>
          )}
        </Row>
      </a>
      {agent.owned ? (
        <Row align="center" padding={{ y: ROW_PAD_Y }}>
          <DeleteAgent agent={agent} onDelete={onDelete} />
        </Row>
      ) : null}
    </Row>
  );
}
