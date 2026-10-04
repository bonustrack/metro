import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { BackLink } from './BackLink.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { fetchScheduleDetail, runSchedule, type JobDetail } from '@metro-labs/client/api/schedules';
import { queryError, refresh, useBoxQuery } from '../lib/queries.js';
import { routeHash } from '@metro-labs/client/route';
import { whenLabel } from '@metro-labs/client/api/when';
import { useDocumentTitle } from '../lib/title.js';
import { LogBlock } from './ui/LogBlock.js';

const KIND: Record<JobDetail['kind'], string> = { timer: 'systemd timer', 'cron-agent': "the agent's crontab" };

function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Row gap={12} align="start">
      <Row width={120}>
        <Text size="2xs" role="secondary">{label}</Text>
      </Row>
      <Text size="2xs">{value}</Text>
    </Row>
  );
}

const at = (iso: string | null): string => (iso === null ? 'unknown' : `${whenLabel(iso)} (${new Date(iso).toLocaleString()})`);

function Facts({ job }: { job: JobDetail }): ReactNode {
  return (
    <Col gap={6}>
      <Field label="Where" value={KIND[job.kind]} />
      <Field label="Schedule" value={job.schedule} />
      <Field label="Runs as" value={job.runsAs} />
      <Field label="Next run" value={job.kind === 'timer' ? at(job.next) : 'from cron'} />
      <Field label="Last run" value={job.kind === 'timer' ? at(job.last) : 'from cron'} />
      <Field label="Last result" value={job.lastResult ?? 'unknown'} />
      <Field label="Command" value={job.command} />
    </Col>
  );
}

function useAction(id: string): { busy: boolean; error: string | null; run: (act: () => Promise<unknown>, failure: string) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (act: () => Promise<unknown>, failure: string): void => {
    setBusy(true);
    setError(null);
    act()
      .then(() => Promise.all([refresh(client, ['schedule', id]), refresh(client, 'schedules')]))
      .catch((err: unknown) => {
        setError(queryError(err, failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, run };
}

function Actions({ job }: { job: JobDetail }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useAction(job.id);
  return (
    <Col gap={8}>
      <Row gap={10}>
        <Button size="md" color="secondary" dark={dark} label="Run now" disabled={busy} onPress={() => { run(() => runSchedule(job.id), 'Could not start that job.'); }} />
      </Row>
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
    </Col>
  );
}

function Block({ title, note, text, empty }: { title: string; note: string | null; text: string; empty: string }): ReactNode {
  return (
    <Col gap={6}>
      <Row gap={10} align="center">
        <Text size="sm" weight="medium">{title}</Text>
        {note === null ? null : <Text size="2xs" role="secondary">{note}</Text>}
      </Row>
      {text.trim() === '' ? <Text size="2xs" role="secondary">{empty}</Text> : <LogBlock text={text} />}
    </Col>
  );
}

export function ScheduledJobPage({ project, id }: { project: string; id: string }): ReactNode {
  const detail = useBoxQuery(['schedule', id], () => fetchScheduleDetail(id), { staleTime: 5_000, refetchInterval: 15_000, retry: false });
  useDocumentTitle(detail.data?.name ?? 'Scheduled');
  return (
    <Col gap={16}>
      <BackLink label="Scheduled" href={routeHash({ kind: 'scheduled', project })} />
      {detail.error !== null ? (
        <Text size="2xs" role="danger">{queryError(detail.error, 'Could not read that job.')}</Text>
      ) : detail.data === undefined ? (
        <Loading />
      ) : (
        <Col gap={20}>
          <PageTitle>{detail.data.name}</PageTitle>
          <Facts job={detail.data} />
          <Actions job={detail.data} />
          {detail.data.script === null ? null : <Block title="Script" note={detail.data.script.path} text={detail.data.script.text} empty="The script is empty." />}
          <Block title="Definition" note={null} text={detail.data.definition} empty="Nothing to show." />
          <Block
            title="Recent output"
            note={detail.data.logSource}
            text={detail.data.logs}
            empty={detail.data.logSource === null ? 'This job writes no log metro can find.' : 'Nothing written yet.'}
          />
        </Col>
      )}
    </Col>
  );
}
