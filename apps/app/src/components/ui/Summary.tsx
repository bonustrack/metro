import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { READABLE_WIDTH } from './sizes.js';
import { plainText, type Segment } from '../../lib/rule-sentence.js';

const SUMMARY_TOP = 14;

export function Summary({ segments }: { segments: readonly Segment[] }): ReactNode {
  const text = plainText(segments);
  if (text === '') return null;
  return (
    <Column width="100%" maxWidth={READABLE_WIDTH} margin={{ top: SUMMARY_TOP }}>
      <Text size="lg" color="secondary" accessibilityLabel={text}>
        {segments.map((segment, at) =>
          segment.value ? (
            <Text key={`${String(at)}:${segment.text}`} size="lg">
              {segment.text}
            </Text>
          ) : (
            segment.text
          ),
        )}
      </Text>
    </Column>
  );
}
