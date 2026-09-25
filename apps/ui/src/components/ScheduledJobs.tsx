import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { ListRow } from './ListRow.js';
import { routeHash } from '../route.js';
import { type ScheduledJob } from '../api/schedules.js';
import { queryError, useSchedulesQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';
import { PageTitle } from './PageTitle.js';
import { SettingsGroup } from './SettingsSection.js';
import { useDocumentTitle } from '../title.js';

const ABOUT = 'Work your agent does on its own at set times. To add one, ask your agent in chat.';
const EMPTY = 'No scheduled task yet. Try asking your agent: "every morning at 8, send me a summary".';

export function detail(job: ScheduledJob): string {
  const parts = [job.schedule];
  if (job.runsAs !== 'agent') parts.push(`runs as ${job.runsAs}`);
  if (job.next !== null) parts.push(`next ${whenLabel(job.next)}`);
  if (job.last !== null) parts.push(`last ${whenLabel(job.last)}${job.lastResult !== null && job.lastResult !== 'success' ? ` (${job.lastResult})` : ''}`);
  return parts.join(' · ');
}

export function ScheduledJobs({ project, onOpen }: { project: string; onOpen: (id: string) => void }): ReactNode {
  const schedules = useSchedulesQuery();
  useDocumentTitle('Scheduled tasks');
  return (
    <Col gap={32}>
      <PageTitle>Scheduled tasks</PageTitle>
      <Text size="sm" role="secondary">{ABOUT}</Text>
      {schedules.error !== null ? (
        <Text size="sm" role="danger">{queryError(schedules.error, 'Could not read the scheduled tasks.')}</Text>
      ) : schedules.data === undefined ? (
        <Text size="sm" role="secondary">Reading the scheduled tasks…</Text>
      ) : schedules.data.jobs.length === 0 ? (
        <SettingsGroup>
          <div className="settings-pad">
            <Text size="sm" role="secondary">{EMPTY}</Text>
          </div>
        </SettingsGroup>
      ) : (
        <SettingsGroup>
          {schedules.data.jobs.map((job) => (
            <ListRow
              key={job.id}
              title={job.name}
              detail={detail(job)}
              href={routeHash({ kind: 'scheduled-job', project, id: job.id })}
              onOpen={() => {
                onOpen(job.id);
              }}
            />
          ))}
        </SettingsGroup>
      )}
    </Col>
  );
}
