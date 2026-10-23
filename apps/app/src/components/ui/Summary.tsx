import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { READABLE_WIDTH } from './sizes.js';

const SUMMARY_TOP = 14;

export function Summary({ text }: { text: string }): ReactNode {
  if (text === '') return null;
  return (
    <Col width="100%" maxWidth={READABLE_WIDTH} margin={{ top: SUMMARY_TOP }}>
      <Text size="lg" role="secondary">
        {text}
      </Text>
    </Col>
  );
}
