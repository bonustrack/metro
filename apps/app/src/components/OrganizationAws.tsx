import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { connectAws, disconnectAws, startAwsLink, type AwsConnection, type AwsOverview } from '@metro-labs/client/api/aws';
import { activeAccount } from '@metro-labs/client/auth/account';
import { routeHash } from '@metro-labs/client/route';
import { DeleteMenu } from './DeleteMenu.js';
import { FormField } from './FormField.js';
import { Icon } from './Icon.js';
import { SignInLink } from './ProviderSignIn.js';
import { useSignInTab } from './sign-in-tab.js';
import { Actions } from './ui/Actions.js';
import { ErrorState } from './ui/ErrorState.js';
import { FocusFrame, FocusIntro, type FocusStep } from './ui/FocusFrame.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { refreshAws, useAwsQuery } from '../lib/aws-queries.js';
import { go } from '../lib/nav.js';
import { queryError } from '../lib/queries.js';
import { useTechnicalDetails } from '../lib/technical.js';

const NOTE = 'See charts, size and storage of servers in your own AWS account. No access key: Metro uses a role made for this organization only.';
const STEP_ONE = 'Opens AWS with the setup ready. Tick the IAM box and create the stack. In an AWS Organization, sign in to the member account first.';
const STEP_TWO = 'When the stack is done, copy RoleArn from its Outputs tab and paste it here.';
const ROLE_RE = /^arn:aws:iam::\d{12}:role\/\S+$/;
const STEPS: FocusStep[] = [
  { id: 'create', label: 'Create the role' },
  { id: 'paste', label: 'Paste the role' },
];

function ConnectionRow({ connection, admin }: { connection: AwsConnection; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const technical = useTechnicalDetails();
  const name = `AWS account ${connection.accountId}`;
  const menu = admin ? (
    <DeleteMenu label={name} action="Disconnect" title={`Disconnect ${name}?`} word={connection.accountId} failure="Could not disconnect the account."
      lines={['Metro stops reading this account, and its servers lose their charts, size and storage here. To remove the role, delete the metro-access stack in AWS.']}
      run={async () => { await disconnectAws(connection.id); await refreshAws(client); }} />
  ) : undefined;
  return <Item title={name} subtitle={technical ? connection.roleArn : 'Connected'} trailing={menu} />;
}

function ConnectSteps({ view }: { view: AwsOverview }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const tab = useSignInTab(startAwsLink, (begun) => begun.url, 'Could not make the AWS link.');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => {
    go({ kind: 'organization' });
  };
  const save = (): void => {
    setBusy(true);
    setError(null);
    connectAws(role.trim())
      .then(() => refreshAws(client))
      .then(close)
      .catch((err: unknown) => { setError(queryError(err, 'Could not connect the account.')); })
      .finally(() => { setBusy(false); });
  };
  const second = tab.started !== null || view.externalId !== null;
  return (
    <FocusFrame title="Connect an AWS account" onClose={close} steps={STEPS} step={second ? 'paste' : 'create'}>
      <Col gap={16}>
        <FocusIntro title="Create the role in AWS" text={STEP_ONE} />
        <Row>
          <SignInLink link={tab.link} label="Open AWS">
            <Button size="md" color={second ? 'secondary' : 'primary'} dark={dark} label="Open AWS" loading={tab.starting} disabled={tab.starting} onPress={tab.start} />
          </SignInLink>
        </Row>
        {tab.error === null ? null : <Text size="xs" role="danger">{tab.error}</Text>}
      </Col>
      {second ? (
        <Col gap={16}>
          <FocusIntro title="Paste the role" text={STEP_TWO} />
          <FormField label="Role ARN" name="aws-role" value={role} placeholder="arn:aws:iam::123456789012:role/metro-access" dark={dark} disabled={busy} onChangeText={setRole} />
          <Actions error={error} cancel={{ onPress: close, disabled: busy }} main={{ label: busy ? 'Checking…' : 'Connect', busy, disabled: !ROLE_RE.test(role.trim()), onPress: save }} />
        </Col>
      ) : null}
    </FocusFrame>
  );
}

export function ConnectAwsPage(): ReactNode {
  const aws = useAwsQuery();
  const close = (): void => {
    go({ kind: 'organization' });
  };
  const view = aws.data;
  if (view !== undefined && view.ready && activeAccount()?.role === 'admin') return <ConnectSteps view={view} />;
  return (
    <FocusFrame title="Connect an AWS account" onClose={close}>
      {aws.error !== null ? (
        <ErrorState title="Could not read the AWS accounts" text={queryError(aws.error, 'Metro did not answer.')} onRetry={aws.refetch} />
      ) : view === undefined ? (
        <RowsSkeleton rows={2} leading={false} />
      ) : (
        <StateBlock icon="server" title="You cannot connect an account here" text={view.ready ? 'Only an admin can connect one.' : (view.reason ?? 'Metro cannot connect an AWS account yet.')} action={{ label: 'Back to the organization', onPress: close }} />
      )}
    </FocusFrame>
  );
}

function awsNote(view: AwsOverview, admin: boolean): string {
  if (!view.ready) return view.reason ?? 'Metro cannot connect an AWS account yet.';
  return admin ? NOTE : `${NOTE} Only an admin can connect one.`;
}

export function OrganizationAws(): ReactNode {
  const palette = useKitPalette();
  const aws = useAwsQuery();
  const admin = activeAccount()?.role === 'admin';
  const view = aws.data;
  if (view === undefined || (!view.ready && view.connections.length === 0)) return null;
  return (
    <Group label="AWS accounts" note={awsNote(view, admin)}>
      {view.connections.map((c) => <ConnectionRow key={c.id} connection={c} admin={admin} />)}
      {view.ready && admin ? <Item title="Connect an AWS account" leading={<Icon name="plus" size={22} color={palette.link} />} href={routeHash({ kind: 'org-aws' })} /> : null}
    </Group>
  );
}
