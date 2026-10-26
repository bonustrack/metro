import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { fetchScheduleDetail, runSchedule, type JobDetail } from '@metro-labs/client/api/schedules';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { LogBlock } from '../ui/LogBlock.js';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { queryError, refresh, useBoxQuery } from '../../lib/queries.js';
import { routineTitle, scheduleWords } from '../../lib/routine-words.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';
import { timeOf } from '../../lib/when-words.js';

const KIND: Record<JobDetail['kind'], string> = { timer: 'A systemd timer', 'cron-agent': 'The agent’s crontab' };


function useRun(id: string): { busy: boolean; error: string | null; run: () => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    setBusy(true);
    setError(null);
    runSchedule(id)
      .then(() => Promise.all([refresh(client, ['schedule', id]), refresh(client, 'schedules')]))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not start that routine.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, run };
}

function resultWord(job: JobDetail, technical: boolean): string {
  if (job.lastResult === null) return 'Not known';
  if (job.lastResult === 'success') return 'Worked';
  return technical ? `Failed (${job.lastResult})` : 'Failed';
}

function Runs({ job, error }: { job: JobDetail; error: string | null }): ReactNode {
  const technical = useTechnicalDetails();
  const failed = job.lastResult !== null && job.lastResult !== 'success';
  if (job.kind !== 'timer')
    return (
      <Group label="Runs" error={error}>
        <Item title="Run times" subtitle="This kind of routine does not keep them. The output below shows what it wrote." />
      </Group>
    );
  return (
    <Group label="Runs" error={error}>
      <Item title="Next run" value={job.next === null ? 'Not planned' : timeOf(job.next, technical)} />
      <Item title="Last run" value={job.last === null ? 'Not known' : timeOf(job.last, technical)} />
      <Item title="Last result" value={resultWord(job, technical)} valueTone={failed ? 'danger' : undefined} />
    </Group>
  );
}

function Details({ job }: { job: JobDetail }): ReactNode {
  const technical = useTechnicalDetails();
  return (
    <Group label="Details">
      <Item title="Schedule" subtitle={technical ? job.schedule : undefined} value={scheduleWords(job.schedule)} />
      <Item title="Runs as" value={job.runsAs} />
      {technical ? <Item title="Where" value={KIND[job.kind]} /> : null}
      {technical ? <Item title="Command" subtitle={job.command} /> : null}
    </Group>
  );
}

function Block({ label, note, text, empty }: { label: string; note: string | null; text: string; empty: string }): ReactNode {
  return (
    <Group label={label} note={note ?? undefined}>
      <Column padding={{ y: 12 }}>{text.trim() === '' ? <Text size="xs" color="secondary">{empty}</Text> : <LogBlock text={text} />}</Column>
    </Group>
  );
}

function Routine({ job, error }: { job: JobDetail; error: string | null }): ReactNode {
  const technical = useTechnicalDetails();
  return (
    <>
      <Runs job={job} error={error} />
      <Details job={job} />
      {job.script === null ? null : <Block label="What it does" note={technical ? job.script.path : null} text={job.script.text} empty="The script is empty." />}
      <Block label="Recent output" note={technical ? job.logSource : null} text={job.logs} empty={job.logSource === null ? 'This routine writes no log Metro can find.' : 'Nothing written yet.'} />
      {technical ? <Block label="Definition" note={null} text={job.definition} empty="Nothing to show." /> : null}
    </>
  );
}

export function RoutinePage({ project, id }: { project: string; id: string }): ReactNode {
  const running = useRun(id);
  const detail = useBoxQuery(['schedule', id], () => fetchScheduleDetail(id), { staleTime: 5_000, refetchInterval: 15_000, retry: false });
  const title = detail.data === undefined ? 'Routine' : routineTitle(detail.data.name);
  useDocumentTitle(title);
  return (
    <AgentDeepPage
      project={project}
      tab="scheduled"
      trail={[{ label: title }]}
      title={title}
      subtitle={detail.data === undefined ? undefined : scheduleWords(detail.data.schedule)}
      action={detail.data === undefined ? undefined : <Button size="md" color="secondary" label="Run now" loading={running.busy} disabled={running.busy} onPress={running.run} />}
    >
      {detail.data === undefined ? (
        detail.error === null ? <RowsSkeleton rows={3} leading={false} /> : <ErrorState title="Could not read that routine" text={queryError(detail.error, 'The agent did not answer.')} onRetry={detail.refetch} />
      ) : (
        <Routine job={detail.data} error={running.error} />
      )}
    </AgentDeepPage>
  );
}
