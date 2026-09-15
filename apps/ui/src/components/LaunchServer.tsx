import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ModelPicker } from './ModelPicker.js';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button, Input } from './ui.js';
import { GROW } from '../theme.js';
import { MetroLogo } from './MetroLogo.js';
import { PageTitle } from './PageTitle.js';
import { LaunchProgress } from './LaunchProgress.js';
import { CopyBlock } from './CopyBlock.js';
import { Loading } from './Loading.js';
import { activeIdentity } from '../auth/identity.js';
import { queryError, refreshServers, useLaunchOverviewQuery } from '../api/queries.js';
import { launchServer, type Launched, type LaunchOverview } from '../api/launch.js';
import { regionRows } from '../aws/regions.js';
import { useDocumentTitle } from '../title.js';

const CARD_WIDTH = 480;
const NO_AUTOFILL = { autoComplete: 'off' } as const;
const HINT =
  'Metro issues the machine from its own AWS account and joins it to its tailnet, so no key of yours is involved. On first boot it installs Node, bun, Claude Code, Tailscale and Metro, joins under a random metro-xxxxxx name that can never clash with another box, and shows up in your server list under the name you give it, live once its Funnel address resolves, usually within five minutes.';
const OFF =
  'This Metro deployment issues no servers, or it does not issue them to you. Add your own server from the list instead.';
const OFF_IDENTITY =
  'If it is yours to configure: metro.box signs its requests with an identity derived from your wallet, never with the wallet itself, so this is the address METRO_LAUNCH_OWNERS has to hold.';

function Off(): ReactNode {
  const identity = activeIdentity();
  return (
    <Col gap={12}>
      <Text size="sm" role="secondary">{OFF}</Text>
      {identity === null ? null : (
        <Col gap={8}>
          <Text size="sm" role="secondary">{OFF_IDENTITY}</Text>
          <CopyBlock label="this browser's metro identity" value={identity.vault.address.toLowerCase()} />
        </Col>
      )}
    </Col>
  );
}

function remainingNote(overview: LaunchOverview): string {
  if (overview.remaining <= 0) return 'You have reached the number of servers Metro will issue to this wallet.';
  return `Metro will issue ${String(overview.remaining)} more ${overview.remaining === 1 ? 'server' : 'servers'} to this wallet.`;
}

function useLaunchForm(): {
  name: string;
  region: string;
  setName: (value: string) => void;
  setRegion: (value: string) => void;
  busy: boolean;
  error: string | null;
  done: Launched | null;
  launch: () => void;
} {
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Launched | null>(null);
  const client = useQueryClient();
  const launch = (): void => {
    if (busy || name.trim() === '' || region.trim() === '') return;
    setBusy(true);
    setError(null);
    launchServer(name.trim(), region.trim())
      .then(async (launched) => {
        await refreshServers(client);
        setDone(launched);
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not launch the server.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { name, region, setName, setRegion, busy, error, done, launch };
}

function LaunchedView({ launched }: { launched: Launched }): ReactNode {
  return (
    <Col gap={14}>
      <Row justify="center">
        <PageTitle>{`Launching ${launched.server.name ?? launched.host}`}</PageTitle>
      </Row>
      <Text size="sm" role="secondary">
        {`It installs everything on first boot, joins the tailnet as ${launched.node}, and is already in your server list. Open it once it is live to create the agent.`}
      </Text>
      <LaunchProgress launched={launched} />
    </Col>
  );
}

function LaunchForm({ overview }: { overview: LaunchOverview }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const form = useLaunchForm();
  if (form.done !== null) return <LaunchedView launched={form.done} />;
  const full = overview.remaining <= 0;
  return (
    <Col gap={16}>
      <Row justify="center">
        <PageTitle>Have Metro issue a server</PageTitle>
      </Row>
      <Text size="sm" role="secondary">{HINT}</Text>
      <Col gap={10}>
        <Col gap={4}>
          <Text size="sm" role="secondary">Name</Text>
          <Input
            name="launch-name"
            value={form.name}
            placeholder="andy"
            inputProps={NO_AUTOFILL}
            disabled={form.busy}
            dark={dark}
            onChangeText={form.setName}
            onSubmit={form.launch}
            style={GROW}
          />
        </Col>
        <ModelPicker
          label="AWS region"
          value={form.region}
          placeholder="eu-west-1"
          models={regionRows(overview.regions.length === 0 ? null : overview.regions)}
          loading={false}
          error={null}
          onOpen={() => undefined}
          onChange={form.setRegion}
        />
      </Col>
      <Text size="sm" role="secondary">{remainingNote(overview)}</Text>
      {form.error === null ? null : <Text size="sm" role="danger">{form.error}</Text>}
      <Row justify="between" align="center" gap={12} wrap>
        <Text size="sm" role="secondary">
          <a className="hint-link" href="#/">Back to your servers</a>
        </Text>
        <Button
          color="primary"
          dark={dark}
          loading={form.busy}
          disabled={form.busy || full || form.name.trim() === '' || form.region.trim() === ''}
          label="Launch"
          onPress={form.launch}
        />
      </Row>
    </Col>
  );
}

function Body(): ReactNode {
  const { data, error } = useLaunchOverviewQuery();
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, OFF)}</Text>;
  if (data === undefined) return <Loading />;
  if (!data.enabled) return <Off />;
  return <LaunchForm overview={data} />;
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
        <Body />
      </Col>
    </Row>
  );
}
