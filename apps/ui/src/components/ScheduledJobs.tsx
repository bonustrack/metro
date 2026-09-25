import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { ListRow } from './ListRow.js';
import { routeHash } from '../route.js';
import { SCHEDULES_SINCE, type ScheduledJob } from '../api/schedules.js';
import { queryError, useModeQuery, useSchedulesQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';
import { olderThan } from '../api/version.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { useDocumentTitle } from '../title.js';

const ABOUT = "The agent's timers and cron jobs. They all run as the user agent; one left in root's home is switched at every start.";

const KIND: Record<ScheduledJob['kind'], string> = { timer: 'timer', 'cron-root': 'cron', 'cron-agent': 'cron' };

export function detail(job: ScheduledJob): string {
  const parts = [KIND[job.kind], job.schedule, `runs as ${job.runsAs}`];
  if (job.next !== null) parts.push(`next ${whenLabel(job.next)}`);
  if (job.last !== null) parts.push(`last ${whenLabel(job.last)}${job.lastResult !== null && job.lastResult !== 'success' ? ` (${job.lastResult})` : ''}`);
  return parts.join(' · ');
}

export function ScheduledJobs({ project, onOpen }: { project: string; onOpen: (id: string) => void }): ReactNode {
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
            <ListRow
              key={job.id}
              title={job.name}
              detail={detail(job)}
              href={routeHash({ kind: 'scheduled-job', project, id: job.id })}
              extra={job.problem === null ? null : <Text size="sm" role="danger">still runs as root</Text>}
              onOpen={() => {
                onOpen(job.id);
              }}
            />
          ))}
        </Col>
      )}
    </Col>
  );
}
