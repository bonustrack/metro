import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { SettingsSection } from './SettingsSection.js';
import { copyText } from '../lib/clipboard.js';

const MASK = '•'.repeat(12);

export function CopyRow({ title, note, value, secret = false }: { title: string; note?: string; value: string; secret?: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  const copy = (): void => {
    copyText(value)
      .then(setCopied)
      .catch(() => undefined);
  };
  return (
    <SettingsSection title={title} note={note}>
      <Row gap={8} align="center">
        {secret ? (
          <Button
            size="md"
            color="secondary"
            dark={dark}
            label={shown ? 'Hide' : 'Show'}
            onPress={() => {
              setShown(!shown);
            }}
          />
        ) : null}
        <Button size="md" color="secondary" dark={dark} label={copied ? 'Copied' : 'Copy'} onPress={copy} />
      </Row>
      <Text size="2xs" role="secondary" numberOfLines={1} selectable={shown}>
        {shown ? value : MASK}
      </Text>
    </SettingsSection>
  );
}
