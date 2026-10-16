import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { stationLabel, type AttachResult } from '@metro-labs/client/api/attach';
import { CopyBlock } from './CopyBlock.js';
import { Field } from './Field.js';
import { Actions } from './ui/Actions.js';

export const CALLBACK_NOTE = 'Paste this as the callback URL at gateway.threema.ch. Keep it private: the URL is the password.';

function activationNote(result: AttachResult): string {
  if (!result.activated) return 'Saved, but Metro could not reload it. It goes live at the next restart.';
  if (result.station === 'webhook') return 'The endpoint is live now. Anything posted to it reaches your agent.';
  return `The ${stationLabel(result.station)} channel is restarting to pick it up. It shows in Chats once connected.`;
}

function Secret({ label, value, note, danger = false }: { label: string; value: string; note: string; danger?: boolean }): ReactNode {
  return (
    <Col gap={8}>
      <CopyBlock label={label} value={value} secret />
      <Text size="xs" role={danger ? 'danger' : 'secondary'}>
        {note}
      </Text>
    </Col>
  );
}

export function AttachedAccount({ result, onDismiss }: { result: AttachResult; onDismiss: () => void }): ReactNode {
  const secret = result.secret;
  const endpoint = result.identity.endpoint;
  const callback = result.identity.callback;
  const fields = Object.entries(result.identity).filter(([k]) => k !== 'endpoint' && k !== 'callback');
  return (
    <Col gap={24}>
      <Col gap={8}>
        <Text accessibilityRole="header" size="2xl" weight="semibold">
          {`${stationLabel(result.station)} attached`}
        </Text>
        <Text size="md" role="secondary">
          {activationNote(result)}
        </Text>
      </Col>
      <Row gap={20} wrap>
        <Field label="id" value={result.accountId} />
        {fields.map(([label, value]) => (
          <Field key={label} label={label} value={value} />
        ))}
      </Row>
      {endpoint === undefined ? null : <Secret label="post events here" value={endpoint} note="Paste it into the provider as the webhook URL. Keep it private: the URL is the password." />}
      {callback === undefined ? null : <Secret label="threema delivers here" value={callback} note={CALLBACK_NOTE} />}
      {secret === null ? null : <Secret label={secret.label} value={secret.value} note={`${secret.note} Copy it somewhere safe before you close this.`} danger />}
      <Actions main={{ label: 'Done', onPress: onDismiss }} />
    </Col>
  );
}
