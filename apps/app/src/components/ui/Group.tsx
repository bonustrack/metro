import { type ReactNode } from 'react';
import { View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { READABLE_WIDTH } from './sizes.js';
import { useIsNarrow } from '../../lib/media.js';

const GAP_WIDE = 40;
const GAP_NARROW = 36;

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
  right?: ReactNode;
  error?: string | null;
  wide?: boolean;
  children: ReactNode;
}

function Line({ text, role }: { text: string | null | undefined; role: 'secondary' | 'danger' }): ReactNode {
  if (text === undefined || text === null) return null;
  return (
    <Col margin={{ top: 6 }}>
      <Text size="xs" role={role}>
        {text}
      </Text>
    </Col>
  );
}

export function Group({ label, note, action, right, error, wide = false, children }: GroupProps): ReactNode {
  const trailing = action ?? right;
  return (
    <Col width="100%" maxWidth={wide ? undefined : READABLE_WIDTH}>
      {label === undefined && trailing === undefined ? null : (
        <Row align="center" justify="between" gap={12} minHeight={32}>
          <Text size="xs" role="secondary" numberOfLines={1}>
            {label ?? ''}
          </Text>
          {trailing}
        </Row>
      )}
      <Rows>{children}</Rows>
      <Line text={note} role="secondary" />
      <Line text={error} role="danger" />
    </Col>
  );
}
