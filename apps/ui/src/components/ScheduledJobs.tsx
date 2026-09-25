import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { changeSchedule, SCHEDULES_SINCE, type ScheduledJob } from '../api/agent-user.js';
import { queryError, refresh, useModeQuery, useSchedulesQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';
import { olderThan } from '../api/version.js';

const ABOUT = 'Timers and cron jobs on this machine. A job still pointing into /root stops working once Claude Code runs as its own user.';

const KIND: Record<ScheduledJob['kind'], string> = { timer: 'timer', 'cron-root': 'cron', 'cron-agent': 'cron' };

function detail(job: ScheduledJob): string {
  const parts = [KIND[job.kind], job.schedule, `runs as ${job.runsAs}`];
  if (job.next !== null) parts.push(`next ${whenLabel(job.next)}`);
  if (job.last !== null) parts.push(`last ${whenLabel(job.last)}${job.lastResult !== null && job.lastResult !== 'success' ? ` (${job.lastResult})` : ''}`);
  return parts.join(' · ');
}

function JobRow({ job, agentUser }: { job: ScheduledJob; agentUser: string | null }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (action: 'agent' | 'root'): void => {
    setBusy(true);
    setError(null);
    changeSchedule(job.id, action)
      .then(() => refresh(client, 'schedules'))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change that job.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={4} padding={{ y: 6 }}>
      <Row gap={10} align="center" wrap>
        <Text size="sm" weight="semibold">{job.name}</Text>
        <Text size="sm" role="secondary">{detail(job)}</Text>
        {job.usesRoot ? <Text size="sm" role="danger">points into /root</Text> : null}
      </Row>
      <Text size="sm" role="secondary" numberOfLines={2}>{job.command}</Text>
      <JobActions job={job} agentUser={agentUser} busy={busy} dark={dark} act={act} />
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

interface ActionsProps {
  job: ScheduledJob;
  agentUser: string | null;
  busy: boolean;
  dark: boolean;
  act: (action: 'agent' | 'root') => void;
}

function JobActions({ job, agentUser, busy, dark, act }: ActionsProps): ReactNode {
  const toAgent = agentUser !== null && job.kind !== 'cron-agent' && job.runsAs === 'root';
  const toRoot = job.kind === 'timer' && job.converted;
  if (!toAgent && !toRoot) return null;
  return (
    <Row gap={10}>
      {toAgent ? <Button size="sm" color="secondary" dark={dark} label={`Run as ${agentUser}`} disabled={busy} onPress={() => { act('agent'); }} /> : null}
      {toRoot ? <Button size="sm" color="secondary" dark={dark} label="Back to root" disabled={busy} onPress={() => { act('root'); }} /> : null}
    </Row>
  );
}

export function ScheduledJobs(): ReactNode {
  const mode = useModeQuery();
  const supported = mode.data !== undefined && !olderThan(mode.data.version, SCHEDULES_SINCE);
  const schedules = useSchedulesQuery(supported);
  if (mode.data === undefined) return null;
  return (
    <Col gap={8}>
      <Text size="md" weight="semibold">Scheduled jobs</Text>
      <Text size="sm" role="secondary">{ABOUT}</Text>
      {!supported ? (
        <Text size="sm" role="secondary">{`Needs metro ${SCHEDULES_SINCE}. Update first, from the Server page.`}</Text>
      ) : schedules.error !== null ? (
        <Text size="sm" role="danger">{queryError(schedules.error, 'Could not read the scheduled jobs.')}</Text>
      ) : schedules.data === undefined ? (
        <Text size="sm" role="secondary">Reading the scheduled jobs…</Text>
      ) : schedules.data.jobs.length === 0 ? (
        <Text size="sm" role="secondary">No timer or cron job on this machine.</Text>
      ) : (
        <Col>
          {schedules.data.jobs.map((job) => (
            <JobRow key={job.id} job={job} agentUser={schedules.data.agentUser} />
          ))}
        </Col>
      )}
    </Col>
  );
}
