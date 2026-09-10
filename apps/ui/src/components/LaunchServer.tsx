import { Fragment, type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ModelPicker } from './ModelPicker.js';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button, Input } from './ui.js';
import { GROW } from '../theme.js';
import { MetroLogo } from './MetroLogo.js';
import { PageTitle } from './PageTitle.js';
import { CopyBlock } from './CopyBlock.js';
import { LinkedText } from './LinkedText.js';
import { activeIdentity } from '../auth/identity.js';
import { queryError, useServersQuery } from '../api/queries.js';
import { IAM_POLICY, launchBox, type Launched } from '../aws/launch.js';
import { INSTANCE_TYPE, ROOT_GIB } from '../aws/ec2.js';
import { readAwsSettings, storeAwsSettings, tailnetSuffix } from '../aws/settings.js';
import { describeRegions, regionRows } from '../aws/regions.js';
import { useDocumentTitle } from '../title.js';

const CARD_WIDTH = 480;
const NO_AUTOFILL = { autoComplete: 'off' } as const;
const HINT = `Launches an Ubuntu 24.04 arm64 ${INSTANCE_TYPE} with an ${ROOT_GIB} GiB gp3 disk in your AWS account, from this page: the browser signs the EC2 calls itself with the access key below, which stays in this browser and never reaches Metro. On first boot the machine installs Node, bun, Claude Code, Tailscale and Metro, joins your tailnet under the name you give it, and shows up in your server list, live once its Funnel address resolves, usually within five minutes.`;
const KEYS_HINT =
  'Use a dedicated IAM user holding only the policy below. The Tailscale auth key comes from the admin console under Settings, Keys: make it single-use, since it travels in the instance user data.';
const LINKS = [
  { text: 'IAM user', href: 'https://console.aws.amazon.com/iam/home#/users' },
  { text: 'admin console', href: 'https://login.tailscale.com/admin/settings/keys' },
];

interface Values {
  name: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  tailscaleAuthKey: string;
  tailnet: string;
}

interface Field {
  key: keyof Values;
  label: string;
  placeholder: string;
  secret?: boolean;
}

const FIELDS: Field[] = [
  { key: 'name', label: 'Name', placeholder: 'andy' },
  { key: 'accessKeyId', label: 'AWS access key id', placeholder: 'AKIA…' },
  { key: 'secretAccessKey', label: 'AWS secret access key', placeholder: 'kept in this browser', secret: true },
  { key: 'tailscaleAuthKey', label: 'Tailscale auth key', placeholder: 'tskey-auth-…', secret: true },
  { key: 'tailnet', label: 'Tailnet', placeholder: 'tail1234.ts.net' },
];

function initialValues(): Values {
  const stored = readAwsSettings();
  return {
    name: '',
    region: stored?.region ?? '',
    accessKeyId: stored?.accessKeyId ?? '',
    secretAccessKey: stored?.secretAccessKey ?? '',
    tailscaleAuthKey: '',
    tailnet: '',
  };
}

function useLaunch(): {
  values: Values;
  set: (key: keyof Values, value: string) => void;
  busy: boolean;
  error: string | null;
  done: Launched | null;
  defaultTailnet: string;
  launch: () => void;
} {
  const [values, setValues] = useState<Values>(initialValues);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Launched | null>(null);
  const { data: servers } = useServersQuery();
  const defaultTailnet = tailnetSuffix((servers ?? []).map((s) => s.host)) ?? '';
  const launch = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const credentials = { accessKeyId: values.accessKeyId.trim(), secretAccessKey: values.secretAccessKey.trim() };
    launchBox({
      name: values.name,
      region: values.region,
      credentials,
      tailscaleAuthKey: values.tailscaleAuthKey,
      tailnet: values.tailnet.trim() === '' ? defaultTailnet : values.tailnet,
      owner: activeIdentity()?.address ?? '',
    })
      .then((launched) => {
        storeAwsSettings({ ...credentials, region: values.region.trim() });
        setDone(launched);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not launch the server.');
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const set = (key: keyof Values, value: string): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };
  return { values, set, busy, error, done, defaultTailnet, launch };
}

type Form = ReturnType<typeof useLaunch>;

const REGIONS_STALE_MS = 10 * 60_000;

function regionNote(ready: boolean, count: number | undefined, error: unknown, fetching: boolean): string {
  if (!ready) return 'The standard regions. Once the key is typed, the list shows the regions enabled in your account.';
  if (error !== null && error !== undefined) return `${queryError(error, 'Could not list your regions.')} Showing the standard ones.`;
  if (count === undefined) return fetching ? 'Listing the regions enabled in your account…' : '';
  return `${String(count)} regions are enabled in your account.`;
}

function RegionSelect({ form }: { form: Form }): ReactNode {
  const credentials = { accessKeyId: form.values.accessKeyId.trim(), secretAccessKey: form.values.secretAccessKey.trim() };
  const ready = credentials.accessKeyId !== '' && credentials.secretAccessKey !== '';
  const { data, error, isFetching } = useQuery({
    queryKey: ['aws-regions', credentials.accessKeyId, credentials.secretAccessKey.length],
    enabled: ready,
    retry: false,
    staleTime: REGIONS_STALE_MS,
    queryFn: () => describeRegions(credentials),
  });
  return (
    <Col gap={4}>
      <ModelPicker
        label="AWS region"
        value={form.values.region}
        placeholder="eu-west-1"
        models={regionRows(data ?? null)}
        loading={ready && isFetching && data === undefined}
        error={null}
        onOpen={() => undefined}
        onChange={(value) => {
          form.set('region', value);
        }}
      />
      <Text size="sm" role="secondary">{regionNote(ready, data?.length, error, isFetching)}</Text>
    </Col>
  );
}

function Fields({ form }: { form: Form }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={10}>
      {FIELDS.map((field) => (
        <Fragment key={field.key}>
        <Col gap={4}>
          <Text size="sm" role="secondary">{field.label}</Text>
          <Input
            name={`launch-${field.key}`}
            value={form.values[field.key]}
            placeholder={field.key === 'tailnet' && form.defaultTailnet !== '' ? form.defaultTailnet : field.placeholder}
            inputType={field.secret === true ? 'password' : 'text'}
            inputProps={NO_AUTOFILL}
            disabled={form.busy}
            dark={dark}
            onChangeText={(value) => {
              form.set(field.key, value);
            }}
            onSubmit={form.launch}
            style={GROW}
          />
        </Col>
        {field.key === 'secretAccessKey' ? <RegionSelect form={form} /> : null}
        </Fragment>
      ))}
    </Col>
  );
}

function LaunchedView({ launched }: { launched: Launched }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={14}>
      <Row justify="center">
        <PageTitle>{`Launching ${launched.server.name ?? launched.host}`}</PageTitle>
      </Row>
      <Text size="sm" role="secondary">
        {`Instance ${launched.instanceId} is starting from ${launched.image.name}${launched.zone === null ? '' : ` in ${launched.zone}`}. It installs everything on first boot and then joins your tailnet as ${launched.node}. The server is already in your list and turns Live once its address resolves, usually within five minutes. Open it then to create the agent.`}
      </Text>
      <CopyBlock label="address" value={launched.host} />
      <Text size="sm" role="secondary">
        {`To watch the install, ssh root@${launched.node} over Tailscale SSH and read /var/log/metro-setup.log.`}
      </Text>
      <Row justify="end">
        <Button
          color="primary"
          dark={dark}
          label="Back to your servers"
          onPress={() => {
            window.location.hash = '#/';
          }}
        />
      </Row>
    </Col>
  );
}

function LaunchForm(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const form = useLaunch();
  if (form.done !== null) return <LaunchedView launched={form.done} />;
  return (
    <Col gap={16}>
      <Row justify="center">
        <PageTitle>Launch a server on AWS</PageTitle>
      </Row>
      <Text size="sm" role="secondary">{HINT}</Text>
      <Fields form={form} />
      <LinkedText text={KEYS_HINT} links={LINKS} />
      <CopyBlock label="IAM policy for that user" value={IAM_POLICY} />
      {form.error === null ? null : (
        <Text size="sm" role="danger">{form.error}</Text>
      )}
      <Row justify="between" align="center" gap={12} wrap>
        <Text size="sm" role="secondary">
          <a className="hint-link" href="#/">Back to your servers</a>
        </Text>
        <Button color="primary" dark={dark} loading={form.busy} disabled={form.busy} label="Launch" onPress={form.launch} />
      </Row>
    </Col>
  );
}

export function LaunchServer(): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  useDocumentTitle('Launch a server');
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={20} width="100%" maxWidth={CARD_WIDTH} padding={24} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <LaunchForm />
      </Col>
    </Row>
  );
}
