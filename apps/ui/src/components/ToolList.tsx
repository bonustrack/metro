import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { Pill } from './Pill.js';
import { CountBadge } from './CountBadge.js';
import { Loading } from './Loading.js';
import { fetchConnectorTools } from '../api/connectors.js';
import { queryError, useBoxQuery } from '../api/queries.js';
import { SHRINK } from '../theme.js';

const ROW_PAD_Y = 8;

export function ToolList({ id }: { id: string }): ReactNode {
  const palette = useKitPalette();
  const { data, error } = useBoxQuery(['connector-tools', id], () => fetchConnectorTools(id), { staleTime: 60_000, retry: false });
  return (
    <Col gap={10}>
      <Row gap={10} align="center">
        <Text size="lg" weight="semibold">
          Tools
        </Text>
        {data === undefined ? null : <CountBadge count={data.length} />}
      </Row>
      {error !== null ? (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not list the tools.')}
        </Text>
      ) : data === undefined ? (
        <Loading />
      ) : data.length === 0 ? (
        <Text size="sm" role="secondary">
          This connector lists no tools.
        </Text>
      ) : (
        <Col>
          {data.map((tool) => (
            <Row key={tool.name} align="center" gap={12} padding={{ y: ROW_PAD_Y }} border={{ bottom: { width: 1, color: palette.border } }}>
              <Col gap={2} style={SHRINK} flex={1}>
                <Text size="md" weight="semibold" numberOfLines={1}>
                  {tool.title}
                </Text>
                {tool.description === '' ? null : (
                  <Text size="sm" role="secondary" numberOfLines={2}>
                    {tool.description}
                  </Text>
                )}
              </Col>
              {tool.readOnly ? <Pill label="Read-only" /> : null}
            </Row>
          ))}
        </Col>
      )}
    </Col>
  );
}
