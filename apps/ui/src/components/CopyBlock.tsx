import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { FieldLabel } from './FieldLabel';

const MASK = '•'.repeat(5);

interface CopyBlockProps {
  label: string;
  value: string;
  secret?: boolean;
  hide?: string | null;
  actions?: ReactNode;
}

function display(value: string, hide: string | null | undefined): string {
  if (hide === null || hide === undefined || hide === '') return MASK;
  return value.split(hide).join(MASK);
}

export function CopyBlock({
  label,
  value,
  secret = false,
  hide,
  actions,
}: CopyBlockProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const masked = secret && !revealed;

  const copy = (): void => {
    navigator.clipboard?.writeText(value).then(
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
        <FieldLabel>{label}</FieldLabel>
        <Row gap={6} align="center">
          {secret ? (
            <Button
              size="sm"
              color="secondary"
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
          {actions}
        </Row>
      </Row>
      <Text size="sm" variant="mono" selectable={!masked}>
        {masked ? display(value, hide) : value}
      </Text>
    </Col>
  );
}
