import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { connectorHost, type Connector } from '../api/connectors';
import { DeleteConnector } from './DeleteConnector';
import { opensElsewhere } from './link';

const ROW_PAD_Y = 12;

function summary(row: Connector): string {
  const tools = row.verified?.tools ?? 0;
  const label = `${String(tools)} tool${tools === 1 ? '' : 's'}`;
  if (row.signIn === 'connected') return `${label} · signed in`;
  if (row.signIn === 'disconnected') return `${label} · signed out`;
  if (row.auth === 'header') return `${label} · header auth`;
  return label;
}

interface ConnectorRowProps {
  row: Connector;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}

export function ConnectorRow({
  row,
  onOpen,
  onDelete,
  onError,
}: ConnectorRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      justify="between"
      align="stretch"
      gap={12}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <a
        className="row-link"
        href={`#/connector/${row.id}`}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen(row.id);
        }}
      >
        <Col gap={1} flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }}>
          <Row gap={10} align="center" minWidth={0}>
            <span className="row-title">
              <Text
                size="lg"
                weight="semibold"
                role={row.signIn === 'disconnected' ? 'secondary' : 'default'}
                numberOfLines={1}
              >
                {row.name}
              </Text>
            </span>
            <Text
              size="sm"
              role="secondary"
              numberOfLines={1}
              style={SHRINK}
            >
              {connectorHost(row.url)}
            </Text>
          </Row>
          <Text size="sm" role="secondary">{summary(row)}</Text>
        </Col>
      </a>
      <Row align="center" padding={{ y: ROW_PAD_Y }}>
        <DeleteConnector
          connector={row}
          onDelete={onDelete}
          onError={onError}
          size="lg"
        />
      </Row>
    </Row>
  );
}
