import { AwsError } from '../src/aws/ec2.ts';
import { BOX, instance, otherServer, type FakeAccount } from './deletion-fake.ts';

export const LONG_AGO = '2026-09-01T10:00:00.000Z';
export const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

type Setup = (account: FakeAccount) => void;

const notFound: Setup = (a) => {
  a.instances = [otherServer()];
};
const terminated: Setup = (a) => {
  a.instances = [instance({ state: 'terminated', disks: [] }), otherServer()];
};
const failing =
  (code: string, message: string): Setup =>
  (a) => {
    a.describeFails = new AwsError(code, message, 'ec2:DescribeInstances');
  };

export const ENTRY_ONLY: { when: string; state: string; aws: Setup }[] = [
  { when: 'AWS does not know the instance', state: 'not-found', aws: notFound },
  { when: 'AWS reports the instance terminated', state: 'terminated', aws: terminated },
];

export const STILL_REFUSED: { when: string; status: number; error: string; addedAt?: string; aws: Setup }[] = [
  { when: 'AWS does not know an instance whose row is 5 minutes old', status: 409, error: `The server ${BOX} was just launched, try again in a few minutes.`, addedAt: minutesAgo(5), aws: notFound },
  {
    when: 'AWS is still shutting the instance down',
    status: 409,
    error: `AWS is still shutting down the server ${BOX}, try again in a few minutes.`,
    aws: (a) => {
      a.instances = [instance({ state: 'shutting-down' }), otherServer()];
    },
  },
  { when: 'AWS throttles DescribeInstances', status: 503, error: 'Request limit exceeded.', aws: failing('RequestLimitExceeded', 'Request limit exceeded.') },
  { when: 'AWS does not accept the key', status: 503, error: 'AWS was not able to validate', aws: failing('AuthFailure', 'AWS was not able to validate the provided access credentials') },
  { when: 'the key may not call DescribeInstances', status: 503, error: "Metro's AWS key may not call ec2:DescribeInstances", aws: failing('UnauthorizedOperation', 'You are not authorized.') },
  { when: 'EC2 cannot be reached', status: 503, error: 'Could not reach EC2 in us-east-1.', aws: failing('Unreachable', 'Could not reach EC2 in us-east-1.') },
];

export const CHANGED_SINCE_DIALOG: { when: string; before: Setup; after: Setup }[] = [
  { when: 'an instance AWS did not know is back', before: notFound, after: (a) => (a.instances = [instance(), otherServer()]) },
  { when: 'a running instance is no longer known', before: () => undefined, after: notFound },
  { when: 'an instance AWS did not know is now terminated', before: notFound, after: terminated },
  { when: 'a terminated instance is no longer known', before: terminated, after: notFound },
  { when: 'a running instance was stopped', before: () => undefined, after: (a) => (a.instances = [instance({ state: 'stopped' }), otherServer()]) },
];

interface View {
  name: string;
  instanceId: string;
  state: string;
  volumes: { volumeId: string }[];
}

export const confirmOf = (view: View): Record<string, unknown> => ({
  name: view.name,
  instanceId: view.instanceId,
  state: view.state,
  volumeIds: view.volumes.map((v) => v.volumeId),
});
