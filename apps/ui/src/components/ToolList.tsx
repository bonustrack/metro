import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import { Spacer } from '@stage-labs/kit/react-native/spacer';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { TOOL_KINDS, type ConnectorTool, type ToolKind } from '../api/connectors';

const LABEL: Record<ToolKind, string> = {
  read: 'Read-only tools',
  write: 'Write/delete tools',
};

function CountBadge({ count }: { count: number }): ReactNode {
  return (
    <Row
      align="center"
      justify="center"
      minWidth={24}
      padding={{ x: 7, y: 1 }}
      radius={6}
      surface="raised"
    >
      <Text size="sm" role="secondary">{String(count)}</Text>
    </Row>
  );
}

function ToolRow({ tool }: { tool: ConnectorTool }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col
      gap={2}
      padding={{ y: 12 }}
      border={{ top: { width: 1, color: palette.border } }}
    >
      <Row gap={8} align="center" wrap>
        <Text size="lg" variant="mono">{tool.name}</Text>
        {tool.annotated ? null : (
          <Text size="2xs" role="secondary">not annotated</Text>
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
  const palette = useKitPalette();
  const [open, setOpen] = useState(true);
  if (tools.length === 0) return null;
  return (
    <Col>
      <Pressable
        pressedOpacity={0.6}
        onPress={() => {
          setOpen(!open);
        }}
      >
        <Row align="center" gap={10} padding={{ y: 12 }}>
          <Icon
            name={open ? 'chevronDown' : 'chevronRight'}
            size={16}
            color={palette.sub}
          />
          <Text weight="semibold">{LABEL[kind]}</Text>
          <CountBadge count={tools.length} />
          <Spacer />
        </Row>
      </Pressable>
      {open ? (
        <Col padding={{ left: 26 }}>
          {tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
        </Col>
      ) : null}
    </Col>
  );
}

export function ToolList({
  tools,
  recorded,
}: {
  tools: ConnectorTool[];
  recorded: number;
}): ReactNode {
  if (tools.length === 0)
    return (
      <Text size="sm" role="secondary">
        {recorded > 0
          ? `Metro counted ${String(recorded)} tools here but did not keep their details — this connector was last checked before Metro recorded them. Press Check to fetch them.`
          : 'This server published no tools the last time Metro checked.'}
      </Text>
    );
  return (
    <Col>
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
