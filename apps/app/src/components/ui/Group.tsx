import { type ReactNode } from 'react';
import { View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useIsNarrow } from '../../lib/media.js';

const LABEL_WIDTH = 180;
const COLUMN_GAP = 32;
const LABEL_TOP = 17;
const NOTE_WIDTH = 560;
const GAP_WIDE = 48;
const GAP_NARROW = 40;

const CLIP = { overflow: 'hidden' } as const;
const TUCK = { marginBottom: -1 } as const;

export function Rows({ children }: { children: ReactNode }): ReactNode {
  return (
    <View style={CLIP}>
      <View style={TUCK}>{children}</View>
    </View>
  );
}

export function Groups({ children }: { children: ReactNode }): ReactNode {
  return <Col gap={useIsNarrow() ? GAP_NARROW : GAP_WIDE}>{children}</Col>;
}

interface GroupProps {
  label?: string;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
}

function Note({ text }: { text: string | undefined }): ReactNode {
  if (text === undefined) return null;
  return (
    <Col margin={{ top: 6 }} maxWidth={NOTE_WIDTH}>
      <Text size="xs" role="secondary">
        {text}
      </Text>
    </Col>
  );
}

export function Group({ label, note, action, children }: GroupProps): ReactNode {
  const stacked = useIsNarrow();
  const heading = label === undefined ? null : (
    <Text size="xs" role="secondary">
      {label}
    </Text>
  );
  if (stacked)
    return (
      <Col>
        {heading === null && action === undefined ? null : (
          <Row align="center" justify="between" gap={12} minHeight={32}>
            {heading}
            {action}
          </Row>
        )}
        <Rows>{children}</Rows>
        <Note text={note} />
      </Col>
    );
  return (
    <Row align="start" gap={COLUMN_GAP}>
      <Col width={LABEL_WIDTH} gap={8} padding={{ top: LABEL_TOP }}>
        {heading}
        {action}
      </Col>
      <Col flex={1} minWidth={0}>
        <Rows>{children}</Rows>
        <Note text={note} />
      </Col>
    </Row>
  );
}
