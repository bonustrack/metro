import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
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
}

export function PasteAddress({ hint, name, placeholder, finish, ready }: PasteAddressProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useModelAction();
  const [pasted, setPasted] = useState('');
  const submit = (text: string): void => {
    run(() => finish(text), 'Could not finish the sign-in.');
  };
  const change = (text: string): void => {
    setPasted(text);
    if (!busy && ready?.(text) === true) submit(text);
  };
  return (
    <Col gap={6} maxWidth={FIELD_WIDTH}>
      <Text size="2xs" role="secondary">
        {hint}
      </Text>
      <FormField label="Sign-in address" name={name} value={pasted} placeholder={placeholder} dark={dark} onChangeText={change} style={GROW} />
      <Row gap={8}>
        <Button
          size="lg"
          dark={dark}
          label={busy ? 'Finishing…' : 'Finish sign-in'}
          loading={busy}
          disabled={busy || pasted.trim() === ''}
          onPress={() => {
            submit(pasted);
          }}
        />
      </Row>
      {error !== null ? <Text size="2xs" role="danger">{error}</Text> : null}
    </Col>
  );
}

export function SignedInAs({ connection, how = '', children }: { connection: ConnectionRow; how?: string; children: ReactNode }): ReactNode {
  return (
    <Col gap={10}>
      <Text size="2xs">
        Signed in{how === '' ? '' : ` ${how}`}
        {connection.account === null ? '' : ` as ${connection.account}`}
        {connection.plan === null ? '' : ` (${connection.plan})`}
      </Text>
      {children}
    </Col>
  );
}

export function SignInLink({ link, label, children }: { link: string | null; label: string; children: ReactNode }): ReactNode {
  return (
    <Row gap={8} wrap align="center">
      {children}
      {link !== null ? (
        <TextLink size="2xs" url={link}>{label}</TextLink>
      ) : null}
    </Row>
  );
}
