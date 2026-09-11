import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { CopyBlock } from './CopyBlock.js';
import { progressOf, type Progress, type StepState } from '../aws/boot-log.js';
import type { Launched } from '../aws/launch.js';
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

function headline(instance: string | null, progress: Progress | null, live: boolean): string {
  if (live) return 'Live. The daemon answers on its address.';
  if (progress?.failed === true) return 'The first-boot script stopped. The last lines below say where.';
  if (progress?.finished === true) return 'Installed. Waiting for the Funnel address to resolve, usually a minute or two.';
  if (progress?.steps.some((s) => s.state !== 'pending') === true) return 'Installing…';
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
  `Instance ${launched.instanceId}${launched.zone === null ? '' : ` in ${launched.zone}`}`;

const funnelState = (live: boolean, progress: Progress | null): StepState =>
  live ? 'done' : progress?.finished === true ? 'active' : 'pending';

const captureNote = (capturedAt: string | null): string =>
  capturedAt === null ? CAPTURE_NOTE : `${CAPTURE_NOTE} Last capture ${whenLabel(capturedAt)}.`;

function Steps({ launched, watch, progress, live }: { launched: Launched; watch: LaunchWatch; progress: Progress | null; live: boolean }): ReactNode {
  return (
    <Col>
      <StepRow label={instanceLabel(launched)} state={watch.instance === 'running' || live ? 'done' : 'active'} />
      {(progress?.steps ?? []).map((step) => (
        <StepRow key={step.key} label={step.label} state={step.state} />
      ))}
      <StepRow label={`Funnel address ${launched.host}`} state={funnelState(live, progress)} />
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
        label="Back to your servers"
        onPress={() => {
          window.location.hash = '#/';
        }}
      />
      {live ? (
        <Button
          color="primary"
          dark={dark}
          label="Open it"
          onPress={() => {
            window.location.hash = `#/${launched.server.id}`;
          }}
        />
      ) : null}
    </Row>
  );
}

export function LaunchProgress({ launched }: { launched: Launched }): ReactNode {
  const status = useServerStatus(launched.host);
  const live = status.data?.state === 'live';
  const watch = useLaunchWatch({ instanceId: launched.instanceId, region: launched.region, name: launched.server.name ?? launched.host, launchedAt: launched.launchedAt }, live);
  const progress = watch.log === null ? null : progressOf(watch.log);
  return (
    <Col gap={14}>
      <Text size="md" weight="semibold">{headline(watch.instance, progress, live)}</Text>
      {watch.error === null ? null : <Text size="sm" role="danger">{watch.error}</Text>}
      <Steps launched={launched} watch={watch} progress={progress} live={live} />
      <Text size="sm" role="secondary">{captureNote(watch.capturedAt)}</Text>
      <LogTail lines={watch.log?.lines ?? []} />
      <CopyBlock label="address" value={launched.host} />
      <Actions launched={launched} live={live} />
    </Col>
  );
}
