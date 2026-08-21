import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { connectorHost, type Connector } from '../api/connectors';
import { ConnectorIcon } from './ConnectorIcon';

const ROW_PAD_Y = 12;
const ICON_SIZE = 28;

function summary(row: Connector): string {
  const tools = row.verified?.tools ?? 0;
  const label = `${String(tools)} tool${tools === 1 ? '' : 's'}`;
  if (row.auth === 'oauth') return `${label} · signed in`;
  if (row.auth === 'header') return `${label} · header auth`;
  return label;
}

interface ConnectorRowProps {
  row: Connector;
  onOpen: (id: string) => void;
}

export function ConnectorRow({ row, onOpen }: ConnectorRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      align="stretch"
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <a
        className="row-link"
        href={`#/connector/${row.id}`}
        onClick={(e) => {
          e.preventDefault();
          onOpen(row.id);
        }}
      >
        <ConnectorIcon
          name={row.name}
          url={row.url}
          icon={row.verified?.icon ?? ''}
          size={ICON_SIZE}
        />
        <Col gap={1} flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }}>
          <Row gap={10} align="center" minWidth={0}>
            <span className="row-title">
              <Text size="lg" weight="semibold" numberOfLines={1}>
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
    </Row>
  );
}
