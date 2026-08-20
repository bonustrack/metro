import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { stationLabel, type AttachResult } from '../api/attach';
import { CopyBlock } from './CopyBlock';
import { Field } from './Field';

function activationNote(result: AttachResult): string {
  if (!result.activated)
    return 'The station is stored, but Metro could not reload it. It becomes live at the next daemon restart.';
  if (result.station === 'webhook')
    return 'The endpoint is live now. Anything posted to it reaches your agent.';
  return `The ${stationLabel(result.station)} station is restarting to pick it up. It appears in the list above once it is connected.`;
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
  const url = result.identity.url;
  const fields = Object.entries(result.identity).filter(([k]) => k !== 'url');
  return (
    <Col gap={14}>
        <Col gap={4}>
          <Text size="lg" weight="semibold">
            {stationLabel(result.station)} attached
          </Text>
          <Text size="sm" role="secondary">
            {activationNote(result)}
          </Text>
        </Col>
        <Row gap={20} wrap>
          <Field label="id" value={result.accountId} />
          {fields.map(([label, value]) => (
            <Field key={label} label={label} value={value} />
          ))}
        </Row>
        {url === undefined ? null : (
          <CopyBlock label="endpoint url" value={url} />
        )}
        {secret !== null ? (
          <Col gap={8}>
            <CopyBlock label={secret.label} value={secret.value} secret />
            <Text size="sm" role="danger">
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
