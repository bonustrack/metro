import { type ReactNode, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { BootView, Launched } from '@metro-labs/client/api/launch';
import { AgentAvatar } from '../AgentAvatar.js';
import { canDeleteServer, DeleteServerDialog } from '../DeleteServer.js';
import { Icon } from '../Icon.js';
import { Spinner } from '../Spinner.js';
import { Rows } from '../ui/Group.js';
import { allSides } from '../ui/edges.js';
import { TechnicalLog } from './LaunchFrame.js';
import { LaunchError } from './LaunchError.js';
import { failedLaunchNote, launchOutcome, plainSteps, stepTimes, timeLeftLine, type PlainStep } from '../../lib/launch-steps.js';
import { useServerStatus } from '../../lib/queries.js';
import { useLaunchWatch } from '../../lib/use-launch.js';
import { useNow } from '../../lib/use-now.js';
import { go } from '../../lib/nav.js';

const LEAD = 30;
const AVATAR = 64;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 18, borderBottomWidth: 1 },
  lead: { width: LEAD, alignItems: 'center' },
});

export interface LaunchSubject {
  launched: Launched;
  name: string;
  avatar: string | null;
  pictureError: string | null;
  place: string | null;
  startedAt: number;
}

function Lead({ step }: { step: PlainStep }): ReactNode {
  const palette = useKitPalette();
  if (step.state === 'done') return <Icon name="check" size={22} color={palette.success} />;
  if (step.state === 'failed') return <Icon name="exclamationCircle" size={22} color={palette.danger} />;
  if (step.state === 'active') return <Spinner color={palette.link} />;
  return <Row width={26} height={26} radius={13} border={allSides(palette.border, 2)} />;
}

function StepLine({ step, at }: { step: PlainStep; at: string | null }): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.row, { borderBottomColor: palette.border }]);
  const color = step.state === 'active' ? palette.link : step.state === 'pending' ? palette.sub : palette.text;
  return (
    <View style={frame}>
      <View style={styles.lead}><Lead step={step} /></View>
      <Col flex={1} minWidth={0}>
        <Text size="md" color={step.state === 'failed' ? palette.danger : color}>{step.label}</Text>
      </Col>
      {at === null ? null : <Text size="xs" role="secondary">{at}</Text>}
    </View>
  );
}

function captureMs(boot: BootView | null): number | null {
  const at = boot?.at === null || boot?.at === undefined ? NaN : Date.parse(boot.at);
  return Number.isFinite(at) ? at : null;
}

function useSeen(steps: PlainStep[], boot: BootView | null): Record<string, number> {
  const [seen, setSeen] = useState<Record<string, number>>({});
  const done = steps.filter((step) => step.state === 'done').map((step) => step.key).join(',');
  useEffect(() => {
    const keys = done === '' ? [] : done.split(',');
    setSeen((current) => {
      const fresh = keys.filter((key) => current[key] === undefined);
      if (fresh.length === 0) return current;
      const capture = captureMs(boot);
      const at = (key: string): number => (key === 'server' || key === 'answers' || capture === null ? Date.now() : capture);
      return { ...current, ...Object.fromEntries(fresh.map((key) => [key, at(key)])) };
    });
  }, [done, boot]);
  return seen;
}

function Ready({ subject }: { subject: LaunchSubject }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row>
      <Button size="lg" color="primary" dark={dark} label={`Open ${subject.name}`} onPress={() => { go({ kind: 'home', project: subject.launched.server.id }); }} />
    </Row>
  );
}

function useLaunchState(subject: LaunchSubject): { steps: PlainStep[]; boot: BootView | null; instance: string | null; error: string | null } {
  const status = useServerStatus(subject.launched.host);
  const live = status.data?.state === 'live';
  const watch = useLaunchWatch(subject.launched.server.id, live);
  const boot = watch.boot;
  const steps = plainSteps({ name: subject.name, place: subject.place, instance: watch.instance, live, steps: boot?.steps ?? [], finished: boot?.finished === true, failed: boot?.failed === true });
  return { steps, boot, instance: watch.instance, error: watch.error };
}

function Failed({ subject, steps, instance, lines }: { subject: LaunchSubject; steps: PlainStep[]; instance: string | null; lines: string[] }): ReactNode {
  const [deleting, setDeleting] = useState(false);
  const server = subject.launched.server;
  const admin = canDeleteServer(server);
  const stopped = steps.find((s) => s.state === 'failed')?.label ?? 'a step';
  const reason = `It stopped at “${stopped}”. ${failedLaunchNote(instance, admin)}`;
  const action = admin
    ? { label: `Delete ${subject.name}`, onPress: () => { setDeleting(true); } }
    : { label: 'Back to your agents', onPress: () => { go({ kind: 'servers' }); } };
  return (
    <>
      <LaunchError title={`${subject.name} could not finish setting up`} reason={reason} lines={lines} action={action} />
      {deleting ? <DeleteServerDialog server={server} onClose={() => { setDeleting(false); }} /> : null}
    </>
  );
}

function Headline({ subject, ready }: { subject: LaunchSubject; ready: boolean }): ReactNode {
  const now = useNow(15_000);
  return (
    <Row align="center" gap={20}>
      <AgentAvatar seed={subject.launched.host} src={subject.avatar} size={AVATAR} />
      <Col flex={1} minWidth={0} gap={4}>
        <Text accessibilityRole="header" size="2xl" weight="semibold">{ready ? `${subject.name} is ready` : `${subject.name} is getting ready`}</Text>
        <Text size="md" role="secondary">{ready ? 'Open it to connect a chat and finish the setup.' : timeLeftLine((now - subject.startedAt) / 1000)}</Text>
      </Col>
    </Row>
  );
}

export function LaunchWatch({ subject }: { subject: LaunchSubject }): ReactNode {
  const { steps, boot, instance, error } = useLaunchState(subject);
  const times = stepTimes(steps, useSeen(steps, boot), subject.startedAt);
  const outcome = launchOutcome(steps);
  const lines = boot?.lines ?? [];
  if (outcome === 'failed') return <Failed subject={subject} steps={steps} instance={instance} lines={lines} />;
  return (
    <>
      <Headline subject={subject} ready={outcome === 'ready'} />
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
      {subject.pictureError === null ? null : <Text size="md" role="danger">{`${subject.pictureError} Add it later in ${subject.name}’s Settings, Profile.`}</Text>}
      <Rows>{steps.map((step, i) => <StepLine key={step.key} step={step} at={times[i] ?? null} />)}</Rows>
      {outcome === 'ready' ? <Ready subject={subject} /> : null}
      <TechnicalLog lines={lines} />
    </>
  );
}
