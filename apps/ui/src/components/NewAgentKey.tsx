import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type CreatedAgent } from '../api/client';

function CopyBlock({ label, value }: { label: string; value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
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
        <Button size="sm" color="secondary" onPress={copy} label={copied ? 'Copied' : 'Copy'} />
      </Row>
      <Text size="sm" variant="mono" selectable>
        {value}
      </Text>
    </Col>
  );
}

export function NewAgentKey({
  created,
  onDismiss,
}: {
  created: CreatedAgent;
  onDismiss: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Card dark={dark} padding={18}>
      <Col gap={16}>
        <Col gap={4}>
          <Text size="lg" weight="semibold">
            Agent “{created.name}” created
          </Text>
          <Text size="sm" role="danger">
            This API key is shown once and is never displayed again. Copy it now.
          </Text>
        </Col>
        <CopyBlock label="api key" value={created.key} />
        <CopyBlock label="add to claude code" value={created.command} />
        <Row justify="end">
          <Button color="secondary" onPress={onDismiss} label="I saved it" />
        </Row>
      </Col>
    </Card>
  );
}
