import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { BackLink } from './BackLink.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { fetchScheduleDetail, runSchedule, type JobDetail } from '../api/schedules.js';
import { queryError, refresh, useBoxQuery } from '../api/queries.js';
import { routeHash } from '../route.js';
import { whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const KIND: Record<JobDetail['kind'], string> = { timer: 'systemd timer', 'cron-agent': "the agent's crontab" };

function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Row gap={12} align="start">
      <Row width={120}>
        <Text size="sm" role="secondary">{label}</Text>
      </Row>
      <Text size="sm">{value}</Text>
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
        <Button size="sm" color="secondary" dark={dark} label="Run now" disabled={busy} onPress={() => { run(() => runSchedule(job.id), 'Could not start that job.'); }} />
      </Row>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

function Block({ title, note, text, empty }: { title: string; note: string | null; text: string; empty: string }): ReactNode {
  return (
    <Col gap={6}>
      <Row gap={10} align="center">
        <Text size="md" weight="semibold">{title}</Text>
        {note === null ? null : <Text size="sm" role="secondary">{note}</Text>}
      </Row>
      {text.trim() === '' ? <Text size="sm" role="secondary">{empty}</Text> : <pre className="job-block">{text}</pre>}
    </Col>
  );
}

export function ScheduledJobPage({ project, id, onBack }: { project: string; id: string; onBack: () => void }): ReactNode {
  const detail = useBoxQuery(['schedule', id], () => fetchScheduleDetail(id), { staleTime: 5_000, refetchInterval: 15_000, retry: false });
  useDocumentTitle(detail.data?.name ?? 'Scheduled');
  return (
    <Col gap={16}>
      <BackLink label="Scheduled" href={routeHash({ kind: 'scheduled', project })} onPress={onBack} />
      {detail.error !== null ? (
        <Text size="sm" role="danger">{queryError(detail.error, 'Could not read that job.')}</Text>
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
