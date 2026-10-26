import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { FieldLabel } from './FieldLabel.js';
import { copyText } from '../lib/clipboard.js';

const MASK = '•'.repeat(5);

interface CopyBlockProps {
  label: string;
  value: string;
  secret?: boolean;
}

export function CopyBlock({ label, value, secret = false }: CopyBlockProps): ReactNode {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const masked = secret && !revealed;
  const copy = (): void => {
    copyText(value)
      .then(setCopied)
      .catch(() => undefined);
  };
  return (
    <Column gap={6}>
      <Row justify="spaceBetween" align="center" gap={12}>
        <FieldLabel>{label}</FieldLabel>
        <Row gap={6} align="center">
          {secret ? (
            <Button
              size="md"
              color="secondary"
              onPress={() => {
                setRevealed(!revealed);
              }}
              label={revealed ? 'Hide' : 'Reveal'}
            />
          ) : null}
          <Button size="md" color="secondary" onPress={copy} label={copied ? 'Copied' : 'Copy'} />
        </Row>
      </Row>
      <Text size="md" selectable={!masked}>
        {masked ? MASK : value}
      </Text>
    </Column>
  );
}
