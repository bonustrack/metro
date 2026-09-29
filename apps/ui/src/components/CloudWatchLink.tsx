import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { Modal } from './Modal.js';
import { FieldLabel } from './FieldLabel.js';
import { queryError } from '../api/queries.js';
import { setMetricsLink, type AgentRow, type MetricsLink } from '../api/admin.js';

const INTRO =
  'The Usage charts read CloudWatch for this instance. A server Metro launched needs nothing here. For a server in another AWS account, give the ARN of the metro-cloudwatch-read role made in that account.';
const NONE: MetricsLink = { instanceId: '', region: '', roleArn: '' };

interface FieldProps {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function LinkField({ label, value, placeholder, disabled, onChange }: FieldProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={4}>
      <FieldLabel>{label}</FieldLabel>
      <Input name={label} value={value} placeholder={placeholder} disabled={disabled} dark={dark} onChangeText={onChange} />
    </Col>
  );
}

interface DialogProps {
  agent: AgentRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function CloudWatchLinkDialog({ agent, onClose, onSaved }: DialogProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [link, setLink] = useState<MetricsLink>(agent.metrics ?? NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: MetricsLink): void => {
    setBusy(true);
    setError(null);
    setMetricsLink(agent.id, next)
      .then(onSaved)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the link.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const edit = (key: keyof MetricsLink) => (value: string) => {
    setLink({ ...link, [key]: value });
  };
  return (
    <Modal title={`CloudWatch for ${agent.name ?? agent.host}`} open onClose={busy ? () => undefined : onClose}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {INTRO}
        </Text>
        <LinkField label="Instance id" value={link.instanceId} placeholder="i-0123456789abcdef0" disabled={busy} onChange={edit('instanceId')} />
        <LinkField label="Region" value={link.region} placeholder="eu-central-2" disabled={busy} onChange={edit('region')} />
        <LinkField label="Role ARN, other AWS account only" value={link.roleArn} placeholder="arn:aws:iam::123456789012:role/metro-cloudwatch-read" disabled={busy} onChange={edit('roleArn')} />
        {error === null ? null : (
          <Text size="sm" role="danger">
            {error}
          </Text>
        )}
        <Row justify="between" align="center" gap={12} wrap>
          <Button color="secondary" dark={dark} disabled={busy || agent.metrics === null} onPress={() => { save(NONE); }} label="Remove link" />
          <Button color="primary" dark={dark} loading={busy} disabled={busy || link.instanceId.trim() === ''} onPress={() => { save(link); }} label="Save" />
        </Row>
      </Col>
    </Modal>
  );
}
