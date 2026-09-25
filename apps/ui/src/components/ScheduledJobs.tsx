import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { retrySchedule, SCHEDULES_SINCE, type ScheduledJob } from '../api/schedules.js';
import { queryError, refresh, useModeQuery, useSchedulesQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';
import { olderThan } from '../api/version.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { useDocumentTitle } from '../title.js';

const ABOUT = "The agent's timers and cron jobs. They all run as the user agent; one left in root's home is switched at every start.";

const KIND: Record<ScheduledJob['kind'], string> = { timer: 'timer', 'cron-root': 'cron', 'cron-agent': 'cron' };

function detail(job: ScheduledJob): string {
  const parts = [KIND[job.kind], job.schedule, `runs as ${job.runsAs}`];
  if (job.next !== null) parts.push(`next ${whenLabel(job.next)}`);
  if (job.last !== null) parts.push(`last ${whenLabel(job.last)}${job.lastResult !== null && job.lastResult !== 'success' ? ` (${job.lastResult})` : ''}`);
  return parts.join(' · ');
}

function JobRow({ job }: { job: ScheduledJob }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = (): void => {
    setBusy(true);
    setError(null);
    retrySchedule(job.id)
      .then(() => refresh(client, 'schedules'))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not switch that job.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const stuck = job.problem ?? error;
  return (
    <Col gap={4} padding={{ y: 6 }}>
      <Row gap={10} align="center" wrap>
        <Text size="sm" weight="semibold">{job.name}</Text>
        <Text size="sm" role="secondary">{detail(job)}</Text>
      </Row>
      <Text size="sm" role="secondary" numberOfLines={2}>{job.command}</Text>
      {stuck === null ? null : (
        <Row gap={10} align="center" wrap>
          <Text size="sm" role="danger">{`Still runs as root: ${stuck}`}</Text>
          <Button size="sm" color="secondary" dark={dark} label="Retry" disabled={busy} onPress={retry} />
        </Row>
      )}
    </Col>
  );
}

export function ScheduledJobs(): ReactNode {
  const mode = useModeQuery();
  const supported = mode.data !== undefined && !olderThan(mode.data.version, SCHEDULES_SINCE);
  const schedules = useSchedulesQuery(supported);
  useDocumentTitle('Scheduled');
  if (mode.data === undefined) return <Loading />;
  return (
    <Col gap={16}>
      <PageTitle>Scheduled</PageTitle>
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
            <JobRow key={job.id} job={job} />
          ))}
        </Col>
      )}
    </Col>
  );
}
