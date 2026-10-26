import { type ReactNode } from 'react';
import { View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
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
  return <Column gap={useIsNarrow() ? GAP_NARROW : GAP_WIDE}>{children}</Column>;
}

interface GroupProps {
  label?: string;
  note?: string;
  action?: ReactNode;
  error?: string | null;
  wide?: boolean;
  children: ReactNode;
}

function Line({ text, role }: { text: string | null | undefined; role: 'secondary' | 'danger' }): ReactNode {
  if (text === undefined || text === null) return null;
  return (
    <Column margin={{ top: 6 }}>
      <Text size="xs" color={role}>
        {text}
      </Text>
    </Column>
  );
}

export function GroupTitle({ label, action }: { label?: string | undefined; action?: ReactNode }): ReactNode {
  if (label === undefined && action === undefined) return null;
  return (
    <Row align="center" justify="spaceBetween" gap={12} minHeight={32}>
      <Text size="xs" color="secondary" numberOfLines={1}>
        {label ?? ''}
      </Text>
      {action}
    </Row>
  );
}

export function Group({ label, note, action, error, wide = false, children }: GroupProps): ReactNode {
  return (
    <Column width="100%" maxWidth={wide ? undefined : READABLE_WIDTH}>
      <GroupTitle label={label} action={action} />
      <Rows>{children}</Rows>
      <Line text={note} role="secondary" />
      <Line text={error} role="danger" />
    </Column>
  );
}
