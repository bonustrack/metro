import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { GROW } from '../lib/style.js';
import { type ConnectionRow } from '@metro-labs/client/api/model';
import { useModelAction } from './sign-in-tab.js';
import { TextLink } from './TextLink.js';

export const FIELD_WIDTH = 420;

interface PasteAddressProps {
  hint: string;
  name: string;
  placeholder: string;
  finish: (pasted: string) => Promise<unknown>;
  ready?: (pasted: string) => boolean;
  onDone?: () => void;
}

export function PasteAddress({ hint, name, placeholder, finish, ready, onDone }: PasteAddressProps): ReactNode {
  const { busy, error, run } = useModelAction(onDone);
  const [pasted, setPasted] = useState('');
  const submit = (text: string): void => {
    run(() => finish(text), 'Could not finish the sign-in.');
  };
  const change = (text: string): void => {
    setPasted(text);
    if (!busy && ready?.(text) === true) submit(text);
  };
  return (
    <Column gap={6} maxWidth={FIELD_WIDTH}>
      <Text size="md" color="secondary">
        {hint}
      </Text>
      <FormField label="Sign-in address" name={name} value={pasted} placeholder={placeholder} onChangeText={change} style={GROW} />
      <Row gap={8}>
        <Button variant="primary"
          size="lg"
          label={busy ? 'Finishing…' : 'Finish sign-in'}
          loading={busy}
          disabled={busy || pasted.trim() === ''}
          onPress={() => {
            submit(pasted);
          }}
        />
      </Row>
      {error !== null ? <Text size="md" color="danger">{error}</Text> : null}
    </Column>
  );
}

export function SignedInAs({ connection, how = '', children }: { connection: ConnectionRow; how?: string; children: ReactNode }): ReactNode {
  return (
    <Column gap={10}>
      <Text size="md">
        Signed in{how === '' ? '' : ` ${how}`}
        {connection.account === null ? '' : ` as ${connection.account}`}
        {connection.plan === null ? '' : ` (${connection.plan})`}
      </Text>
      {children}
    </Column>
  );
}

export function SignInLink({ link, label, children }: { link: string | null; label: string; children: ReactNode }): ReactNode {
  return (
    <Row gap={8} wrap align="center">
      {children}
      {link !== null ? (
        <TextLink size="md" url={link}>{label}</TextLink>
      ) : null}
    </Row>
  );
}
