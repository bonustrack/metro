import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { GROW } from '../theme.js';
import { type ConnectionRow } from '../api/model.js';
import { useModelAction } from './sign-in-tab.js';

export const FIELD_WIDTH = 420;

interface PasteAddressProps {
  hint: string;
  name: string;
  placeholder: string;
  finish: (pasted: string) => Promise<unknown>;
}

export function PasteAddress({ hint, name, placeholder, finish }: PasteAddressProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useModelAction();
  const [pasted, setPasted] = useState('');
  return (
    <Col gap={6} maxWidth={FIELD_WIDTH}>
      <Text size="sm" role="secondary">
        {hint}
      </Text>
      <Input name={name} value={pasted} placeholder={placeholder} dark={dark} onChangeText={setPasted} style={GROW} />
      <Row gap={8}>
        <Button
          size="sm"
          dark={dark}
          label={busy ? 'Finishing…' : 'Finish sign-in'}
          loading={busy}
          disabled={busy || pasted.trim() === ''}
          onPress={() => {
            run(() => finish(pasted), 'Could not finish the sign-in.');
          }}
        />
      </Row>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

export function SignedInAs({ connection, children }: { connection: ConnectionRow; children: ReactNode }): ReactNode {
  return (
    <Col gap={10}>
      <Text size="sm">
        Signed in{connection.account === null ? '' : ` as ${connection.account}`}
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
        <Text size="sm">
          <a className="hint-link" href={link} target="_blank" rel="noreferrer">
            {label}
          </a>
        </Text>
      ) : null}
    </Row>
  );
}
