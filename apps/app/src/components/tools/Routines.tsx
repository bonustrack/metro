import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { setClaudeMemoryRoutine, type MemoryJob } from '@metro-labs/client/api/claude-box';
import { type ScheduledJob } from '@metro-labs/client/api/schedules';
import { whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { technicalLine } from '../../lib/agent-line.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { go } from '../../lib/nav.js';
import { queryError, refresh, useClaudeSetupQuery, useSchedulesQuery } from '../../lib/queries.js';
import { routineTitle, scheduleWords } from '../../lib/routine-words.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { timeOf } from '../../lib/when-words.js';

const MEMORY_JOB = 'memory-routine';
const MEMORY_SCHEDULE = '0 0,12 * * *';

function lastRun(job: ScheduledJob): { value?: string; failed: boolean } {
  if (job.last === null) return { failed: false };
  const failed = job.lastResult !== null && job.lastResult !== 'success';
  return { value: failed ? `Failed ${whenLabel(job.last)}` : whenLabel(job.last), failed };
}

function RoutineRow({ job, project, agentUser }: { job: ScheduledJob; project: string; agentUser: string }): ReactNode {
  const technical = useTechnicalDetails();
  const last = lastRun(job);
  const other = job.runsAs !== agentUser ? ` · runs as ${job.runsAs}` : '';
  const next = job.next === null ? null : `next ${timeOf(job.next, technical)}`;
  return (
    <Item
      title={routineTitle(job.name)}
      subtitle={`${scheduleWords(job.schedule)}${other}`}
      detail={technical ? technicalLine([job.schedule, next, job.command]) : undefined}
      value={last.value}
      valueTone={last.failed ? 'danger' : undefined}
      href={routeHash({ kind: 'scheduled-job', project, id: job.id })}
    />
  );
}

function memoryLine(job: MemoryJob | null, schedule: string): string {
  if (job?.state === 'own') return `${job.job === null ? 'The agent’s own job' : `Its own job ${job.job}`} keeps its memory, so this one does not run.`;
  if (job?.state === 'unavailable') return 'Starts once Metro runs as its own user on this server.';
  return scheduleWords(schedule);
}

function useMemorySwitch(): { busy: boolean; error: string | null; flip: (on: boolean) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (on: boolean): void => {
    setBusy(true);
    setError(null);
    setClaudeMemoryRoutine(on)
      .then(() => Promise.all([refresh(client, 'claude-setup'), refresh(client, 'schedules')]))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the memory routine.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, flip };
}

function MemoryRow({ on, job, routine, project }: { on: boolean; job: MemoryJob | null; routine: ScheduledJob | undefined; project: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const memory = useMemorySwitch();
  return (
    <Item
      title="Memory routine"
      subtitle={memory.error ?? memoryLine(job, routine?.schedule ?? MEMORY_SCHEDULE)}
      subtitleTone={memory.error === null ? 'secondary' : 'danger'}
      trailing={<Switch checked={on} dark={dark} disabled={memory.busy} name="Memory routine" onChange={memory.flip} />}
      chevron={routine !== undefined}
      onPress={routine === undefined ? undefined : () => { go({ kind: 'scheduled-job', project, id: routine.id }); }}
    />
  );
}

function NoRoutine(): ReactNode {
  const name = useAgentName();
  return <StateBlock icon="clock" title="No routine yet" text={`Try asking ${name}: “every morning at 8, send me a summary”.`} />;
}

function Jobs({ project }: { project: string }): ReactNode {
  const schedules = useSchedulesQuery();
  const setup = useClaudeSetupQuery();
  if (schedules.data === undefined)
    return schedules.error === null ? <RowsSkeleton rows={2} leading={false} /> : <ErrorState title="Could not read the routines" text={queryError(schedules.error, 'The agent did not answer.')} onRetry={schedules.refetch} />;
  const memoryOn = setup.data?.memoryRoutine ?? null;
  const routine = schedules.data.jobs.find((job) => job.name === MEMORY_JOB);
  const jobs = schedules.data.jobs.filter((job) => memoryOn === null || job !== routine);
  return (
    <>
      {memoryOn === null ? null : <MemoryRow on={memoryOn} job={setup.data?.memoryJob ?? null} routine={routine} project={project} />}
      {jobs.map((job) => <RoutineRow key={job.id} job={job} project={project} agentUser={schedules.data?.agentUser ?? 'agent'} />)}
      {jobs.length === 0 && memoryOn === null ? <NoRoutine /> : null}
    </>
  );
}

export function Routines({ project }: { project: string }): ReactNode {
  const name = useAgentName();
  return (
    <Group label="Routines" note={`Work ${name} does on its own at set times. To add one, ask in chat.`}>
      <Jobs project={project} />
    </Group>
  );
}
