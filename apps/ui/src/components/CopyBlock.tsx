import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';

const MASK = '•'.repeat(28);

interface CopyBlockProps {
  label: string;
  value: string;
  secret?: boolean;
}

export function CopyBlock({ label, value, secret = false }: CopyBlockProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const masked = secret && !revealed;

  const copy = (): void => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };

  return (
    <Col gap={6}>
      <Row justify="between" align="center" gap={12}>
        <Text size="2xs" role="secondary" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {label}
        </Text>
        <Row gap={6} align="center">
          {secret ? (
            <Button
              size="sm"
              color="secondary"
              variant="soft"
              dark={dark}
              onPress={() => {
                setRevealed(!revealed);
              }}
              label={revealed ? 'Hide' : 'Reveal'}
            />
          ) : null}
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            onPress={copy}
            label={copied ? 'Copied' : 'Copy'}
          />
        </Row>
      </Row>
      <Text size="sm" variant="mono" selectable={!masked}>
        {masked ? MASK : value}
      </Text>
    </Col>
  );
}
