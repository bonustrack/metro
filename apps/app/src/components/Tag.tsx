import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';

export function Tag({ label }: { label: string }): ReactNode {
  return (
    <Row padding={{ x: 10, y: 3 }} radius={999} surface="raised">
      <Text size="4xs" role="link" numberOfLines={1}>
        {label}
      </Text>
    </Row>
  );
}
