import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { TOOL_KINDS, type ConnectorTool, type ToolKind } from '../api/connectors';

const LABEL: Record<ToolKind, string> = {
  read: 'Read-only',
  write: 'Write',
  destructive: 'Destructive',
  unspecified: 'Unspecified',
};

const BLURB: Record<ToolKind, string> = {
  read: 'Declared not to modify anything.',
  write: 'Declared to make additive changes only.',
  destructive: 'May overwrite or delete. This is the MCP default whenever a server annotates a tool without ruling it out.',
  unspecified: 'The server published no annotations for these, so Metro will not guess.',
};

function ToolRow({ tool }: { tool: ConnectorTool }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col
      gap={2}
      style={{
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: palette.border,
      }}
    >
      <Row gap={8} align="center" wrap>
        <Text size="sm" variant="mono">{tool.name}</Text>
        {tool.title === '' || tool.title === tool.name ? null : (
          <Text size="sm" role="secondary">{tool.title}</Text>
        )}
        {tool.idempotent ? (
          <Text size="2xs" role="secondary">idempotent</Text>
        ) : null}
        {tool.openWorld ? null : (
          <Text size="2xs" role="secondary">closed world</Text>
        )}
      </Row>
      {tool.description === '' ? null : (
        <Text size="sm" role="secondary" numberOfLines={2}>
          {tool.description}
        </Text>
      )}
    </Col>
  );
}

function KindSection({
  kind,
  tools,
}: {
  kind: ToolKind;
  tools: ConnectorTool[];
}): ReactNode {
  if (tools.length === 0) return null;
  return (
    <Col gap={8}>
      <Row justify="between" align="center" gap={12}>
        <Text weight="semibold">{LABEL[kind]}</Text>
        <Text size="sm" role="secondary">{String(tools.length)}</Text>
      </Row>
      <Text size="sm" role="secondary">{BLURB[kind]}</Text>
      <Col>
        {tools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} />
        ))}
      </Col>
    </Col>
  );
}

export function ToolList({ tools }: { tools: ConnectorTool[] }): ReactNode {
  if (tools.length === 0)
    return (
      <Text size="sm" role="secondary">
        This server published no tools the last time Metro checked.
      </Text>
    );
  return (
    <Col gap={24}>
      {TOOL_KINDS.map((kind) => (
        <KindSection
          key={kind}
          kind={kind}
          tools={tools.filter((t) => t.kind === kind)}
        />
      ))}
    </Col>
  );
}
