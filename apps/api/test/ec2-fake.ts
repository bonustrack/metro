import { AwsError } from '../src/aws/ec2.ts';
import type { ResizeAws } from '../src/aws/resize.ts';

export interface FakeBox {
  state: string;
  type: string;
  architecture: string;
  calls: string[];
  refuse: Partial<Record<'stop' | 'start' | 'setType', AwsError>>;
  noCapacityFor: string | null;
  stuckStopping: boolean;
  blips: number;
  lostStopAnswer: boolean;
  clock: number;
}

export const fakeBox = (over: Partial<FakeBox> = {}): FakeBox => ({
  state: 'running',
  type: 't4g.medium',
  architecture: 'arm64',
  calls: [],
  refuse: {},
  noCapacityFor: null,
  stuckStopping: false,
  blips: 0,
  lostStopAnswer: false,
  clock: 1_800_000_000_000,
  ...over,
});

function settle(box: FakeBox): string {
  const seen = box.state;
  if (box.state === 'stopping' && !box.stuckStopping) box.state = 'stopped';
  if (box.state === 'pending') box.state = 'running';
  return seen;
}

function refused(box: FakeBox, verb: 'stop' | 'start' | 'setType'): Promise<never> | null {
  const err = box.refuse[verb];
  return err === undefined ? null : Promise.reject(err);
}

export function fakeAws(box: FakeBox): ResizeAws {
  return {
    describe: (target) => {
      box.calls.push('describe');
      if (box.blips > 0) {
        box.blips -= 1;
        return Promise.reject(new AwsError('RequestLimitExceeded', 'Request limit exceeded.', 'ec2:DescribeInstances'));
      }
      return Promise.resolve({ instanceId: target.instanceId, state: settle(box), publicIp: null, type: box.type, architecture: box.architecture });
    },
    stop: () => {
      box.calls.push('stop');
      const refusal = refused(box, 'stop');
      if (refusal !== null) return refusal;
      box.state = 'stopping';
      return box.lostStopAnswer ? Promise.reject(new AwsError('Unreachable', 'Could not reach EC2 in us-east-1.', 'ec2:StopInstances')) : Promise.resolve();
    },
    start: () => {
      box.calls.push(`start ${box.type}`);
      const refusal = refused(box, 'start');
      if (refusal !== null) return refusal;
      if (box.noCapacityFor === box.type)
        return Promise.reject(new AwsError('InsufficientInstanceCapacity', 'We currently do not have sufficient capacity.', 'ec2:StartInstances'));
      box.state = 'pending';
      return Promise.resolve();
    },
    setType: (_target, type) => {
      box.calls.push(`setType ${type}`);
      const refusal = refused(box, 'setType');
      if (refusal !== null) return refusal;
      box.type = type;
      return Promise.resolve();
    },
    sleep: (ms) => {
      box.clock += ms;
      return Promise.resolve();
    },
    now: () => box.clock,
  };
}
