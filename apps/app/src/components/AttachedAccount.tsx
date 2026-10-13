import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { stationLabel, type AttachResult } from '@metro-labs/client/api/attach';
import { CopyBlock } from './CopyBlock.js';
import { Field } from './Field.js';

export const CALLBACK_NOTE =
  'Paste this as the callback URL at gateway.threema.ch. Keep it private: the URL is the password.';

function activationNote(result: AttachResult): string {
  if (!result.activated)
    return 'Saved, but Metro could not reload it. It goes live at the next restart.';
  if (result.station === 'webhook')
    return 'The endpoint is live now. Anything posted to it reaches your agent.';
  return `The ${stationLabel(result.station)} channel is restarting to pick it up. It shows above once connected.`;
}

export function AttachedAccount({
  result,
  onDismiss,
}: {
  result: AttachResult;
  onDismiss: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const secret = result.secret;
  const endpoint = result.identity.endpoint;
  const callback = result.identity.callback;
  const fields = Object.entries(result.identity).filter(
    ([k]) => k !== 'endpoint' && k !== 'callback',
  );
  return (
    <Col gap={14}>
        <Col gap={4}>
          <Text size="sm" weight="medium">
            {stationLabel(result.station)} attached
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
        {endpoint === undefined ? null : (
          <Col gap={8}>
            <CopyBlock label="post events here" value={endpoint} secret />
            <Text size="md" role="secondary">
              Paste it into the provider as the webhook URL. Keep it private:
              the URL is the password.
            </Text>
          </Col>
        )}
        {callback === undefined ? null : (
          <Col gap={8}>
            <CopyBlock label="threema delivers here" value={callback} secret />
            <Text size="md" role="secondary">
              {CALLBACK_NOTE}
            </Text>
          </Col>
        )}
        {secret !== null ? (
          <Col gap={8}>
            <CopyBlock label={secret.label} value={secret.value} secret />
            <Text size="md" role="danger">
              {secret.note} Copy it somewhere safe before you close this.
            </Text>
          </Col>
        ) : null}
        <Row justify="end">
          <Button
            color="secondary"
            dark={dark}
            onPress={onDismiss}
            label="Done"
          />
        </Row>
    </Col>
  );
}
