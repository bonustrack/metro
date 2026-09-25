import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { SettingsSection } from './SettingsSection.js';

const MASK = '•'.repeat(12);

interface CopyRowProps {
  title: string;
  note?: string;
  value: string;
  secret?: boolean;
}

export function CopyRow({ title, note, value, secret = false }: CopyRowProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
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
    <SettingsSection title={title} note={note}>
      <Row gap={8} align="center">
        {secret ? (
          <Button
            size="sm"
            color="secondary"
            variant="ghost"
            dark={dark}
            label={shown ? 'Hide' : 'Show'}
            onPress={() => {
              setShown(!shown);
            }}
          />
        ) : null}
        <Button size="sm" color="secondary" dark={dark} label={copied ? 'Copied' : 'Copy'} onPress={copy} />
      </Row>
      {shown ? (
        <Text size="sm" role="secondary" numberOfLines={1} selectable>
          {value}
        </Text>
      ) : (
        <Text size="sm" role="secondary">
          {MASK}
        </Text>
      )}
    </SettingsSection>
  );
}
