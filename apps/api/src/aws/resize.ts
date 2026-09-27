import {
  AwsError,
  describeInstance,
  setInstanceType,
  startInstance,
  stopInstance,
  type AwsCredentials,
  type InstanceState,
} from './ec2.js';

const POLL_MS = 5_000;
const WAIT_LIMIT_MS = 10 * 60_000;
const STOPPED_GRACE_MS = 30_000;

export interface Ec2Target {
  credentials: AwsCredentials;
  region: string;
  instanceId: string;
}

export interface ResizeAws {
  describe: (target: Ec2Target) => Promise<InstanceState>;
  stop: (target: Ec2Target) => Promise<void>;
  start: (target: Ec2Target) => Promise<void>;
  setType: (target: Ec2Target, type: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const LIVE_RESIZE: ResizeAws = {
  describe: (t) => describeInstance(t.credentials, t.region, t.instanceId),
  stop: (t) => stopInstance(t.credentials, t.region, t.instanceId),
  start: (t) => startInstance(t.credentials, t.region, t.instanceId),
  setType: (t, type) => setInstanceType(t.credentials, t.region, t.instanceId, type),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  now: () => Date.now(),
};

export type ResizePhase = 'stopping' | 'resizing' | 'starting' | 'restoring' | 'done' | 'failed';

export interface ResizeJob {
  from: string;
  to: string;
  phase: ResizePhase;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const jobRunning = (job: ResizeJob | undefined): boolean => job !== undefined && job.phase !== 'done' && job.phase !== 'failed';

export function newJob(from: string, to: string, state: string, now: number): ResizeJob {
  const phase: ResizePhase = state === 'running' ? 'stopping' : from === to ? 'starting' : 'resizing';
  return { from, to, phase, error: null, startedAt: new Date(now).toISOString(), finishedAt: null };
}

class ResizeError extends Error {}

export function explain(err: unknown, type: string): string {
  if (!(err instanceof AwsError)) return err instanceof Error ? err.message : String(err);
  if (err.code === 'UnauthorizedOperation' || err.code === 'AccessDeniedException')
    return `Metro's AWS key may not call ${err.action || 'this action'}. Add it to the policy of the IAM user metro.`;
  if (err.code === 'InsufficientInstanceCapacity') return `AWS has no ${type} capacity in this zone right now. Try again later or pick another size.`;
  if (err.code === 'VcpuLimitExceeded')
    return `The AWS account's vCPU quota in this region is too low for ${type}. Raise "Running On-Demand Standard instances" in Service Quotas.`;
  return err.message;
}

type Verdict = 'wait' | 'fail';

async function waitUntil(aws: ResizeAws, target: Ec2Target, want: string[], judge: (state: string, elapsed: number) => Verdict): Promise<InstanceState> {
  const began = aws.now();
  for (;;) {
    const seen = await aws.describe(target).catch(() => null);
    const elapsed = aws.now() - began;
    if (seen !== null && want.includes(seen.state)) return seen;
    if (seen !== null && judge(seen.state, elapsed) === 'fail') throw new ResizeError(`AWS reports the server ${seen.state}, not ${want.join(' or ')}.`);
    if (elapsed >= WAIT_LIMIT_MS) throw new ResizeError(`AWS did not report the server ${want.join(' or ')} within ${String(WAIT_LIMIT_MS / 60_000)} minutes.`);
    await aws.sleep(POLL_MS);
  }
}

const whileStopping = (state: string): Verdict => (state === 'running' || state === 'stopping' ? 'wait' : 'fail');

const whileStarting = (state: string, elapsed: number): Verdict =>
  state === 'pending' || (state === 'stopped' && elapsed < STOPPED_GRACE_MS) ? 'wait' : 'fail';

const whileSettling = (state: string): Verdict => (state === 'pending' || state === 'stopping' ? 'wait' : 'fail');

async function startAndWait(aws: ResizeAws, target: Ec2Target): Promise<void> {
  await aws.start(target);
  await waitUntil(aws, target, ['running'], whileStarting);
}

function finish(aws: ResizeAws, job: ResizeJob, error: string | null): void {
  job.phase = error === null ? 'done' : 'failed';
  job.error = error;
  job.finishedAt = new Date(aws.now()).toISOString();
}

async function stateNow(aws: ResizeAws, target: Ec2Target): Promise<string> {
  return (await aws.describe(target).catch(() => null))?.state ?? 'unknown';
}

async function recover(aws: ResizeAws, target: Ec2Target, job: ResizeJob, why: string): Promise<void> {
  job.phase = 'restoring';
  try {
    const seen = await waitUntil(aws, target, ['running', 'stopped'], whileSettling);
    if (seen.state === 'running') {
      finish(aws, job, seen.type === job.to ? null : `${why} It runs as ${seen.type}.`);
      return;
    }
    if (job.from === job.to) {
      finish(aws, job, `${why} It is stopped.`);
      return;
    }
    if (seen.type !== job.from) await aws.setType(target, job.from);
    await startAndWait(aws, target);
    finish(aws, job, `${why} It runs again as ${job.from}.`);
  } catch (err) {
    const state = await stateNow(aws, target);
    const where = state === 'stopped' ? 'It is stopped. Start it from this page or the AWS console.' : `AWS reports it ${state}.`;
    finish(aws, job, `${why} Starting it again as ${job.from} failed too: ${explain(err, job.from)} ${where}`);
  }
}

export async function runResize(aws: ResizeAws, target: Ec2Target, job: ResizeJob): Promise<void> {
  if (job.phase === 'stopping') {
    try {
      await aws.stop(target);
      await waitUntil(aws, target, ['stopped'], whileStopping);
    } catch (err) {
      await recover(aws, target, job, `Could not stop the server: ${explain(err, job.to)}`);
      return;
    }
  }
  if (job.from !== job.to) {
    job.phase = 'resizing';
    try {
      await aws.setType(target, job.to);
    } catch (err) {
      await recover(aws, target, job, `AWS refused ${job.to}: ${explain(err, job.to)}`);
      return;
    }
  }
  job.phase = 'starting';
  try {
    await startAndWait(aws, target);
    finish(aws, job, null);
  } catch (err) {
    await recover(aws, target, job, `AWS could not start it as ${job.to}: ${explain(err, job.to)}`);
  }
}
