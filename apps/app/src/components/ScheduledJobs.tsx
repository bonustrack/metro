import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { ListRow } from './ListRow.js';
import { routeHash } from '@metro-labs/client/route';
import { type ScheduledJob } from '@metro-labs/client/api/schedules';
import { queryError, useSchedulesQuery } from '../lib/queries.js';
import { whenLabel } from '@metro-labs/client/api/when';
import { PageTitle } from './PageTitle.js';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { useDocumentTitle } from '../lib/title.js';

const ABOUT = 'Work your agent does on its own at set times. To add one, ask your agent in chat.';
const EMPTY = 'No scheduled task yet. Try asking your agent: "every morning at 8, send me a summary".';

export function detail(job: ScheduledJob): string {
  const parts = [job.schedule];
  if (job.runsAs !== 'agent') parts.push(`runs as ${job.runsAs}`);
  if (job.next !== null) parts.push(`next ${whenLabel(job.next)}`);
  if (job.last !== null) parts.push(`last ${whenLabel(job.last)}${job.lastResult !== null && job.lastResult !== 'success' ? ` (${job.lastResult})` : ''}`);
  return parts.join(' · ');
}

export function ScheduledJobs({ project }: { project: string }): ReactNode {
  const schedules = useSchedulesQuery();
  useDocumentTitle('Scheduled tasks');
  return (
    <Col gap={32}>
      <PageTitle>Scheduled tasks</PageTitle>
      <Text size="2xs" role="secondary">{ABOUT}</Text>
      {schedules.error !== null ? (
        <Text size="2xs" role="danger">{queryError(schedules.error, 'Could not read the scheduled tasks.')}</Text>
      ) : schedules.data === undefined ? (
        <Text size="2xs" role="secondary">Reading the scheduled tasks…</Text>
      ) : schedules.data.jobs.length === 0 ? (
        <SettingsGroup>
          <SettingsPad>
            <Text size="2xs" role="secondary">{EMPTY}</Text>
          </SettingsPad>
        </SettingsGroup>
      ) : (
        <SettingsGroup>
          {schedules.data.jobs.map((job) => (
            <ListRow
              key={job.id}
              title={job.name}
              detail={detail(job)}
              href={routeHash({ kind: 'scheduled-job', project, id: job.id })}
            />
          ))}
        </SettingsGroup>
      )}
    </Col>
  );
}
