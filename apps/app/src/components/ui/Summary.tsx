import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { READABLE_WIDTH } from './sizes.js';
import { plainText, type Segment } from '../../lib/rule-sentence.js';

const SUMMARY_TOP = 14;

export function Summary({ segments }: { segments: readonly Segment[] }): ReactNode {
  const text = plainText(segments);
  if (text === '') return null;
  return (
    <Col width="100%" maxWidth={READABLE_WIDTH} margin={{ top: SUMMARY_TOP }}>
      <Text size="lg" role="secondary" accessibilityLabel={text}>
        {segments.map((segment, at) =>
          segment.value ? (
            <Text key={`${String(at)}:${segment.text}`} size="lg" role="default">
              {segment.text}
            </Text>
          ) : (
            segment.text
          ),
        )}
      </Text>
    </Col>
  );
}
