import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { fetchScheduleDetail, runSchedule, type JobDetail } from '@metro-labs/client/api/schedules';
import { whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { Loading } from '../Loading.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { LogBlock } from '../ui/LogBlock.js';
import { Crumbs, PageHeader } from '../ui/PageHeader.js';
import { StateBlock } from '../ui/StateBlock.js';
import { queryError, refresh, useBoxQuery } from '../../lib/queries.js';
import { routineTitle, scheduleWords } from '../../lib/routine-words.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';

const KIND: Record<JobDetail['kind'], string> = { timer: 'A systemd timer', 'cron-agent': 'The agent’s crontab' };

const exact = (iso: string): string => new Date(iso).toLocaleString();
const relative = (iso: string | null): string => (iso === null ? 'Not known' : whenLabel(iso));

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

function Runs({ job }: { job: JobDetail }): ReactNode {
  const failed = job.lastResult !== null && job.lastResult !== 'success';
  if (job.kind !== 'timer')
    return (
      <Group label="Runs">
        <Item title="Run times" subtitle="Cron does not keep them. The output below shows what it wrote." />
      </Group>
    );
  return (
    <Group label="Runs">
      <Item title="Next run" value={job.next === null ? 'Not planned' : exact(job.next)} />
      <Item title="Last run" subtitle={job.last === null ? undefined : exact(job.last)} value={relative(job.last)} />
      <Item title="Last result" value={job.lastResult === null ? 'Not known' : failed ? `Failed (${job.lastResult})` : 'Worked'} valueTone={failed ? 'danger' : undefined} />
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
      <Col padding={{ y: 12 }}>{text.trim() === '' ? <Text size="xs" role="secondary">{empty}</Text> : <LogBlock text={text} />}</Col>
    </Group>
  );
}

function Routine({ job }: { job: JobDetail }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const technical = useTechnicalDetails();
  const running = useRun(job.id);
  return (
    <Col gap={24}>
      <PageHeader
        title={routineTitle(job.name)}
        subtitle={scheduleWords(job.schedule)}
        action={<Button size="md" dark={dark} label="Run now" loading={running.busy} disabled={running.busy} onPress={running.run} />}
      />
      {running.error === null ? null : <Text size="md" role="danger">{running.error}</Text>}
      <Groups>
        <Runs job={job} />
        <Details job={job} />
        {job.script === null ? null : <Block label="Script" note={job.script.path} text={job.script.text} empty="The script is empty." />}
        <Block label="Recent output" note={job.logSource} text={job.logs} empty={job.logSource === null ? 'This routine writes no log Metro can find.' : 'Nothing written yet.'} />
        {technical ? <Block label="Definition" note={null} text={job.definition} empty="Nothing to show." /> : null}
      </Groups>
    </Col>
  );
}

export function RoutinePage({ project, id }: { project: string; id: string }): ReactNode {
  const detail = useBoxQuery(['schedule', id], () => fetchScheduleDetail(id), { staleTime: 5_000, refetchInterval: 15_000, retry: false });
  const title = detail.data === undefined ? 'Routine' : routineTitle(detail.data.name);
  useDocumentTitle(title);
  return (
    <Col gap={8}>
      <Crumbs items={[{ label: 'Tools', href: routeHash({ kind: 'tools', project }) }, { label: title }]} />
      {detail.error !== null ? (
        <StateBlock icon="exclamationCircle" danger title="Could not read that routine" text={queryError(detail.error, 'Try again in a moment.')} />
      ) : detail.data === undefined ? (
        <Loading />
      ) : (
        <Routine job={detail.data} />
      )}
    </Col>
  );
}
