import { describe, expect, test } from 'bun:test';
import { AwsError } from '../src/aws/ec2.ts';
import { explain, jobRunning, newJob, runResize, type ResizeJob } from '../src/aws/resize.ts';
import { fakeAws, fakeBox, type FakeBox } from './ec2-fake.ts';

const TARGET = { credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }, region: 'us-east-1', instanceId: 'i-0abc' };

async function resize(box: FakeBox, to: string): Promise<ResizeJob> {
  const job = newJob(box.type, to, box.state, box.clock);
  await runResize(fakeAws(box), TARGET, job);
  return job;
}

const verbs = (box: FakeBox): string[] => box.calls.filter((call) => call !== 'describe');

describe('a resize', () => {
  test('stops the running box, waits for stopped, changes the type, starts it and waits for running', async () => {
    const box = fakeBox();
    const job = await resize(box, 't4g.large');
    expect(verbs(box)).toEqual(['stop', 'setType t4g.large', 'start t4g.large']);
    expect(job).toMatchObject({ from: 't4g.medium', to: 't4g.large', phase: 'done', error: null });
    expect(job.finishedAt).not.toBeNull();
    expect(box).toMatchObject({ state: 'running', type: 't4g.large' });
    expect(jobRunning(job)).toBe(false);
  });

  test('a stopped box is not stopped again, and ends running on the new size', async () => {
    const box = fakeBox({ state: 'stopped' });
    const job = await resize(box, 'm7g.large');
    expect(verbs(box)).toEqual(['setType m7g.large', 'start m7g.large']);
    expect(job.phase).toBe('done');
    expect(box.state).toBe('running');
  });

  test('the same size on a stopped box only starts it', async () => {
    const box = fakeBox({ state: 'stopped' });
    const job = await resize(box, 't4g.medium');
    expect(verbs(box)).toEqual(['start t4g.medium']);
    expect(job.phase).toBe('done');
  });

  test('no capacity for the new size puts the old size back and starts it again', async () => {
    const box = fakeBox({ noCapacityFor: 't4g.xlarge' });
    const job = await resize(box, 't4g.xlarge');
    expect(verbs(box)).toEqual(['stop', 'setType t4g.xlarge', 'start t4g.xlarge', 'setType t4g.medium', 'start t4g.medium']);
    expect(job.phase).toBe('failed');
    expect(job.error).toContain('no t4g.xlarge capacity');
    expect(job.error).toContain('It runs again as t4g.medium.');
    expect(box).toMatchObject({ state: 'running', type: 't4g.medium' });
  });

  test('a type AWS refuses leaves the size alone and starts the box again', async () => {
    const box = fakeBox({ refuse: { setType: new AwsError('Unsupported', 'The requested configuration is currently not supported.', 'ec2:ModifyInstanceAttribute') } });
    const job = await resize(box, 'm7g.xlarge');
    expect(verbs(box)).toEqual(['stop', 'setType m7g.xlarge', 'start t4g.medium']);
    expect(job.error).toBe('AWS refused m7g.xlarge: The requested configuration is currently not supported. It runs again as t4g.medium.');
    expect(box.state).toBe('running');
  });

  test('when even the way back fails, the error says the box is stopped', async () => {
    const box = fakeBox({ noCapacityFor: 't4g.large' });
    const aws = fakeAws(box);
    const job = newJob('t4g.medium', 't4g.large', 'running', box.clock);
    const start = aws.start;
    aws.start = async (target) => {
      if (box.type === 't4g.medium') throw new AwsError('InsufficientInstanceCapacity', 'none', 'ec2:StartInstances');
      await start(target);
    };
    await runResize(aws, TARGET, job);
    expect(job.phase).toBe('failed');
    expect(job.error).toContain('Starting it again as t4g.medium failed too');
    expect(job.error).toContain('It is stopped');
    expect(box.state).toBe('stopped');
  });

  test('a refused stop changes nothing and names the missing permission', async () => {
    const box = fakeBox({ refuse: { stop: new AwsError('UnauthorizedOperation', 'You are not authorized to perform this operation. User: arn:aws:iam::123456789012:user/metro', 'ec2:StopInstances') } });
    const job = await resize(box, 't4g.large');
    expect(verbs(box)).toEqual(['stop']);
    expect(job.error).toBe("Could not stop the server: Metro may not call ec2:StopInstances in this AWS account. Add it to the policy Metro uses there. It runs as t4g.medium.");
    expect(job.error).not.toContain('123456789012');
    expect(box).toMatchObject({ state: 'running', type: 't4g.medium' });
  });

  test('a box that never finishes stopping ends the job after ten minutes without touching the type', async () => {
    const box = fakeBox({ stuckStopping: true });
    const job = await resize(box, 't4g.large');
    expect(verbs(box)).toEqual(['stop']);
    expect(job.error).toContain('did not report the server stopped within 10 minutes');
    expect(box.type).toBe('t4g.medium');
  });

  test('a start that fails on the same size reports it without a way back', async () => {
    const box = fakeBox({ state: 'stopped', refuse: { start: new AwsError('VcpuLimitExceeded', 'quota', 'ec2:StartInstances') } });
    const job = await resize(box, 't4g.medium');
    expect(verbs(box)).toEqual(['start t4g.medium']);
    expect(job.error).toContain('AWS could not start it as t4g.medium');
    expect(job.error).toContain('Service Quotas');
    expect(job.error).toEndWith('It is stopped.');
  });

  test('AWS failing to answer a state read is waited out', async () => {
    const box = fakeBox({ blips: 3 });
    const job = await resize(box, 't4g.large');
    expect(job).toMatchObject({ phase: 'done', error: null });
    expect(box).toMatchObject({ state: 'running', type: 't4g.large' });
  });

  test('a stop AWS took but never confirmed starts the box again on its old size', async () => {
    const box = fakeBox({ lostStopAnswer: true });
    const job = await resize(box, 't4g.large');
    expect(verbs(box)).toEqual(['stop', 'start t4g.medium']);
    expect(job.error).toBe('Could not stop the server: Could not reach EC2 in us-east-1. It runs again as t4g.medium.');
    expect(box).toMatchObject({ state: 'running', type: 't4g.medium' });
  });

  test('a start that AWS reports late, running on the new size, is a success', async () => {
    const box = fakeBox();
    const aws = fakeAws(box);
    const start = aws.start;
    aws.start = async (target) => {
      await start(target);
      throw new AwsError('Unreachable', 'Could not reach EC2 in us-east-1.', 'ec2:StartInstances');
    };
    const job = newJob('t4g.medium', 't4g.large', 'running', box.clock);
    await runResize(aws, TARGET, job);
    expect(job).toMatchObject({ phase: 'done', error: null });
    expect(box).toMatchObject({ state: 'running', type: 't4g.large' });
  });
});

describe('the job', () => {
  test('starts at the first step the box needs', () => {
    expect(newJob('a', 'b', 'running', 0).phase).toBe('stopping');
    expect(newJob('a', 'b', 'stopped', 0).phase).toBe('resizing');
    expect(newJob('a', 'a', 'stopped', 0).phase).toBe('starting');
    expect(jobRunning(newJob('a', 'b', 'running', 0))).toBe(true);
    expect(jobRunning(undefined)).toBe(false);
  });

  test('errors read as sentences', () => {
    expect(explain(new AwsError('VcpuLimitExceeded', 'x', 'ec2:StartInstances'), 't4g.2xlarge')).toContain('too low for t4g.2xlarge');
    expect(explain(new AwsError('AccessDeniedException', 'x', 'pricing:GetProducts'), '')).toContain('pricing:GetProducts');
    expect(explain(new Error('plain'), '')).toBe('plain');
  });
});
