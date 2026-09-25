import { routeHash } from '../route.js';
import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { CopyBlock } from './CopyBlock.js';
import type { BootView, Launched, StepState } from '../api/launch.js';
import { useLaunchWatch, type LaunchWatch } from '../aws/use-launch.js';
import { useServerStatus } from '../api/queries.js';
import { whenLabel } from '../api/when.js';

const DOT = 8;
const MARK: Record<StepState, string> = { pending: '·', active: '…', done: '✓', failed: '✗' };
const CAPTURE_NOTE = 'AWS captures the console only every few minutes, so this lags the box by that much.';

function StepRow({ label, state }: { label: string; state: StepState }): ReactNode {
  const palette = useKitPalette();
  const color = state === 'done' ? palette.success : state === 'failed' ? palette.danger : state === 'active' ? palette.link : palette.sub;
  return (
    <Row align="center" gap={10} padding={{ y: 4 }}>
      <Row width={DOT} height={DOT} radius={DOT} background={color} />
      <Text size="sm" role={state === 'pending' ? 'secondary' : undefined}>{`${MARK[state]} ${label}`}</Text>
    </Row>
  );
}

function headline(instance: string | null, boot: BootView | null, live: boolean): string {
  if (live) return 'Live. The daemon answers on its address.';
  if (boot?.failed === true) return 'The first-boot script stopped. The last lines below say where.';
  if (boot?.finished === true) return 'Installed. Waiting for the Funnel address to resolve, usually a minute or two.';
  if (boot?.steps.some((s) => s.state !== 'pending') === true) return 'Installing…';
  if (instance === 'running') return 'The instance is running; waiting for the first console capture.';
  return instance === null ? 'Starting the instance…' : `Instance ${instance}.`;
}

function LogTail({ lines }: { lines: string[] }): ReactNode {
  if (lines.length === 0) return null;
  return (
    <div className="boot-log">
      {lines.slice(-30).map((line, index) => (
        <div key={`${String(index)}-${line.slice(0, 16)}`}>{line}</div>
      ))}
    </div>
  );
}

const instanceLabel = (launched: Launched): string =>
  `Instance in ${launched.region}${launched.zone === null ? '' : ` ${launched.zone}`}`;

const funnelState = (live: boolean, boot: BootView | null): StepState =>
  live ? 'done' : boot?.finished === true ? 'active' : 'pending';

const captureNote = (at: string | null): string =>
  at === null ? CAPTURE_NOTE : `${CAPTURE_NOTE} Last capture ${whenLabel(at)}.`;

function Steps({ launched, watch, live }: { launched: Launched; watch: LaunchWatch; live: boolean }): ReactNode {
  return (
    <Col>
      <StepRow label={instanceLabel(launched)} state={watch.instance === 'running' || live ? 'done' : 'active'} />
      {(watch.boot?.steps ?? []).map((step) => (
        <StepRow key={step.key} label={step.label} state={step.state} />
      ))}
      <StepRow label={`Funnel address ${launched.host}`} state={funnelState(live, watch.boot)} />
    </Col>
  );
}

function Actions({ launched, live }: { launched: Launched; live: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="end" gap={10}>
      <Button
        color="secondary"
        dark={dark}
        label="Back to your agents"
        onPress={() => {
          window.location.hash = routeHash({ kind: 'servers' });
        }}
      />
      {live ? (
        <Button
          color="primary"
          dark={dark}
          label="Open it"
          onPress={() => {
            window.location.hash = routeHash({ kind: 'home', project: launched.server.id });
          }}
        />
      ) : null}
    </Row>
  );
}

export function LaunchProgress({ launched }: { launched: Launched }): ReactNode {
  const status = useServerStatus(launched.host);
  const live = status.data?.state === 'live';
  const watch = useLaunchWatch(launched.server.id, live);
  return (
    <Col gap={14}>
      <Text size="lg" weight="medium">{headline(watch.instance, watch.boot, live)}</Text>
      {watch.error === null ? null : <Text size="sm" role="danger">{watch.error}</Text>}
      <Steps launched={launched} watch={watch} live={live} />
      <Text size="sm" role="secondary">{captureNote(watch.boot?.at ?? null)}</Text>
      <LogTail lines={watch.boot?.lines ?? []} />
      <CopyBlock label="address" value={launched.host} />
      <Actions launched={launched} live={live} />
    </Col>
  );
}
