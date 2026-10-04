import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { FormField } from './FormField.js';
import { DeleteMenu } from './DeleteMenu.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { FIELD_WIDTH, SignInLink } from './ProviderSignIn.js';
import { useSignInTab } from './sign-in-tab.js';
import { GROW } from '../lib/style.js';
import { queryError } from '../lib/queries.js';
import { connectAws, disconnectAws, startAwsLink, type AwsConnection, type AwsOverview } from '@metro-labs/client/api/aws';
import { refreshAws, useAwsQuery } from '../lib/aws-queries.js';
import { activeAccount } from '@metro-labs/client/auth/account';

const TITLE = 'AWS accounts';
const NOTE = 'See and manage the Metro servers of your own AWS account: charts, size and storage. No access key: AWS lets Metro take a role that only Metro can use, and only for this organization.';
const STEP_ONE = 'Opens AWS with the setup ready. Check it, tick the IAM box and create the stack. For an account in an AWS Organization, sign in to that member account first.';
const STEP_TWO = 'When the stack is done, copy RoleArn from its Outputs tab and paste it here.';
const MEMBER_NOTE = 'Only an admin of the organization can connect an AWS account.';
const ROLE_RE = /^arn:aws:iam::\d{12}:role\/\S+$/;

function Notice({ text, danger = false }: { text: string; danger?: boolean }): ReactNode {
  return (
    <SettingsPad>
      <Text size="2xs" role={danger ? 'danger' : 'secondary'}>
        {text}
      </Text>
    </SettingsPad>
  );
}

function ConnectionRow({ connection, admin }: { connection: AwsConnection; admin: boolean }): ReactNode {
  const client = useQueryClient();
  return (
    <SettingsSection title={`AWS account ${connection.accountId}`} note={connection.roleArn}>
      {admin ? (
        <DeleteMenu
          label={`AWS account ${connection.accountId}`}
          action="Disconnect"
          title={`Disconnect AWS account ${connection.accountId}?`}
          lines={[
            'Metro stops reading this account. Its linked servers lose their charts, size and storage here.',
            'Nothing changes in AWS. To remove the role, delete the metro-access stack in that account.',
          ]}
          word="disconnect"
          failure="Could not disconnect the account."
          run={async () => {
            await disconnectAws(connection.id);
            await refreshAws(client);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function RoleField(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setBusy(true);
    setError(null);
    connectAws(role.trim())
      .then(async () => {
        setRole('');
        await refreshAws(client);
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not connect the account.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={6} maxWidth={FIELD_WIDTH}>
      <FormField label="Role ARN" labelHidden name="aws-role" value={role} placeholder="arn:aws:iam::123456789012:role/metro-access" dark={dark} disabled={busy} onChangeText={setRole} style={GROW} />
      <Row gap={8}>
        <Button size="lg" color="primary" dark={dark} label={busy ? 'Checking…' : 'Connect'} loading={busy} disabled={busy || !ROLE_RE.test(role.trim())} onPress={save} />
      </Row>
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
    </Col>
  );
}

function ConnectSteps({ view }: { view: AwsOverview }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { starting, started, link, error, start } = useSignInTab(startAwsLink, (begun) => begun.url, 'Could not make the AWS link.');
  return (
    <>
      <SettingsSection title="Connect an AWS account" note={STEP_ONE}>
        <Col gap={6}>
          <SignInLink link={link} label="Open AWS">
            <Button size="md" color="secondary" dark={dark} label="Connect AWS" loading={starting} disabled={starting} onPress={start} />
          </SignInLink>
          {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
        </Col>
      </SettingsSection>
      {started === null && view.externalId === null ? null : (
        <SettingsSection title="Role ARN" note={STEP_TWO}>
          <RoleField />
        </SettingsSection>
      )}
    </>
  );
}

export function OrganizationAws(): ReactNode {
  const aws = useAwsQuery();
  const admin = activeAccount()?.role === 'admin';
  const view = aws.data;
  if (view === undefined || (!view.ready && view.connections.length === 0)) return null;
  return (
    <SettingsGroup title={TITLE} note={NOTE}>
      {view.connections.map((c) => (
        <ConnectionRow key={c.id} connection={c} admin={admin} />
      ))}
      {!view.ready ? <Notice text={view.reason ?? 'Metro cannot connect an AWS account yet.'} /> : admin ? <ConnectSteps view={view} /> : <Notice text={MEMBER_NOTE} />}
    </SettingsGroup>
  );
}
