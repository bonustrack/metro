import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { connectAws, disconnectAws, startAwsLink, type AwsConnection, type AwsOverview } from '@metro-labs/client/api/aws';
import { activeAccount } from '@metro-labs/client/auth/account';
import { DeleteMenu } from './DeleteMenu.js';
import { FormField } from './FormField.js';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';
import { SignInLink } from './ProviderSignIn.js';
import { useSignInTab } from './sign-in-tab.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { refreshAws, useAwsQuery } from '../lib/aws-queries.js';
import { queryError } from '../lib/queries.js';
import { useTechnicalDetails } from '../lib/technical.js';

const NOTE = 'See charts, size and storage of servers in your own AWS account. No access key: Metro uses a role made for this organization only.';
const STEP_ONE = 'Opens AWS with the setup ready. Tick the IAM box and create the stack. In an AWS Organization, sign in to the member account first.';
const STEP_TWO = 'When the stack is done, copy RoleArn from its Outputs tab and paste it here.';
const ROLE_RE = /^arn:aws:iam::\d{12}:role\/\S+$/;

function ConnectionRow({ connection, admin }: { connection: AwsConnection; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const technical = useTechnicalDetails();
  const menu = admin ? (
    <DeleteMenu label={`AWS account ${connection.accountId}`} action="Disconnect" title={`Disconnect AWS account ${connection.accountId}?`} word="disconnect" failure="Could not disconnect the account."
      lines={['Metro stops reading this account. Its servers lose their charts, size and storage here.', 'Nothing changes in AWS. To remove the role, delete the metro-access stack in that account.']}
      run={async () => { await disconnectAws(connection.id); await refreshAws(client); }} />
  ) : undefined;
  return <Item title={`AWS account ${connection.accountId}`} subtitle={technical ? connection.roleArn : 'Connected'} trailing={menu} />;
}

function ConnectModal({ view, onClose }: { view: AwsOverview; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const tab = useSignInTab(startAwsLink, (begun) => begun.url, 'Could not make the AWS link.');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setBusy(true);
    setError(null);
    connectAws(role.trim())
      .then(() => refreshAws(client))
      .then(onClose)
      .catch((err: unknown) => { setError(queryError(err, 'Could not connect the account.')); })
      .finally(() => { setBusy(false); });
  };
  const second = tab.started !== null || view.externalId !== null;
  return (
    <Modal title="Connect an AWS account" open onClose={onClose}>
      <Col gap={20}>
        <Col gap={10}>
          <Text size="md" weight="semibold">1. Create the role in AWS</Text>
          <Text size="md" role="secondary">{STEP_ONE}</Text>
          <Row>
            <SignInLink link={tab.link} label="Open AWS">
              <Button size="md" color="secondary" dark={dark} label="Open AWS" loading={tab.starting} disabled={tab.starting} onPress={tab.start} />
            </SignInLink>
          </Row>
          {tab.error === null ? null : <Text size="md" role="danger">{tab.error}</Text>}
        </Col>
        {second ? (
          <Col gap={10}>
            <Text size="md" weight="semibold">2. Paste the role</Text>
            <Text size="md" role="secondary">{STEP_TWO}</Text>
            <FormField label="Role ARN" name="aws-role" value={role} placeholder="arn:aws:iam::123456789012:role/metro-access" dark={dark} disabled={busy} onChangeText={setRole} />
            {error === null ? null : <Text size="md" role="danger">{error}</Text>}
            <Row justify="end">
              <Button size="lg" color="primary" dark={dark} label={busy ? 'Checking…' : 'Connect'} loading={busy} disabled={busy || !ROLE_RE.test(role.trim())} onPress={save} />
            </Row>
          </Col>
        ) : null}
      </Col>
    </Modal>
  );
}

function awsNote(view: AwsOverview, admin: boolean): string {
  if (!view.ready) return view.reason ?? 'Metro cannot connect an AWS account yet.';
  return admin ? NOTE : `${NOTE} Only an admin can connect one.`;
}

export function OrganizationAws(): ReactNode {
  const palette = useKitPalette();
  const aws = useAwsQuery();
  const [connecting, setConnecting] = useState(false);
  const admin = activeAccount()?.role === 'admin';
  const view = aws.data;
  if (view === undefined || (!view.ready && view.connections.length === 0)) return null;
  const note = awsNote(view, admin);
  return (
    <Group label="AWS accounts" note={note}>
      {view.connections.map((c) => <ConnectionRow key={c.id} connection={c} admin={admin} />)}
      {view.ready && admin ? <Item title="Connect an AWS account" leading={<Icon name="plus" size={22} color={palette.link} />} chevron={false} onPress={() => { setConnecting(true); }} /> : null}
      {connecting ? <ConnectModal view={view} onClose={() => { setConnecting(false); }} /> : null}
    </Group>
  );
}
