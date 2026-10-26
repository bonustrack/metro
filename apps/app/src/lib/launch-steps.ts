type PlainState = 'done' | 'active' | 'pending' | 'failed';

export const mayAddAgent = (role: string | null | undefined): boolean => role === 'admin';

export const ADD_AGENT_ADMIN = 'Only an admin of the organization can add an agent.';

interface BootStepView {
  key: string;
  state: PlainState;
}

export interface LaunchFacts {
  name: string;
  place: string | null;
  instance: string | null;
  steps: BootStepView[];
  finished: boolean;
  failed: boolean;
  live: boolean;
}

export interface PlainStep {
  key: string;
  label: string;
  state: PlainState;
}

const SETUP: { key: string; setup: string[] }[] = [
  { key: 'software', setup: ['packages', 'node', 'bun'] },
  { key: 'user', setup: ['user'] },
  { key: 'network', setup: ['tailscale'] },
  { key: 'metro', setup: ['metro', 'service'] },
];

const GONE = new Set(['terminated', 'shutting-down', 'stopped', 'stopping']);

const TYPICAL_SECONDS = 5 * 60;

function labels(key: string, name: string, place: string | null): [string, string] {
  const where = place === null ? '' : ` in ${place}`;
  if (key === 'server') return [`Server started${where}`, `Starting a server${where}`];
  if (key === 'software') return ['Basic software installed', 'Installing basic software'];
  if (key === 'user') return [`${name} has a user of its own`, `Making a user for ${name}`];
  if (key === 'network') return ['Joined your private network', 'Joining your private network'];
  if (key === 'metro') return ['Metro installed', 'Installing Metro'];
  return [`${name} answers`, `Waiting for ${name} to answer`];
}

function setupState(facts: LaunchFacts, keys: string[]): PlainState {
  if (facts.finished) return 'done';
  const states = keys.map((key) => facts.steps.find((step) => step.key === key)?.state ?? 'pending');
  if (states.includes('failed')) return 'failed';
  if (states.every((state) => state === 'done')) return 'done';
  return states.some((state) => state !== 'pending') ? 'active' : 'pending';
}

function serverState(facts: LaunchFacts): PlainState {
  if (facts.instance !== null && GONE.has(facts.instance)) return 'failed';
  if (facts.instance === 'running' || facts.steps.some((step) => step.state !== 'pending') || facts.finished) return 'done';
  return 'active';
}

function promote(states: PlainState[]): PlainState[] {
  if (states.some((state) => state === 'active' || state === 'failed')) return states;
  const first = states.indexOf('pending');
  return first === -1 ? states : states.map((state, at) => (at === first ? 'active' : state));
}

export function plainSteps(facts: LaunchFacts): PlainStep[] {
  const keys = ['server', ...SETUP.map((group) => group.key), 'answers'];
  const raw: PlainState[] = facts.live
    ? keys.map(() => 'done')
    : [serverState(facts), ...SETUP.map((group) => setupState(facts, group.setup)), 'pending'];
  const states = promote(raw);
  return keys.map((key, at) => {
    const state = states[at] ?? 'pending';
    const [done, todo] = labels(key, facts.name, facts.place);
    return { key, label: state === 'done' ? done : todo, state };
  });
}

export function launchOutcome(steps: PlainStep[]): 'ready' | 'failed' | 'working' {
  if (steps.some((step) => step.state === 'failed')) return 'failed';
  return steps.every((step) => step.state === 'done') ? 'ready' : 'working';
}

export function stepTimes(steps: PlainStep[], seen: Record<string, number>, startedAt: number): (string | null)[] {
  let later = Number.POSITIVE_INFINITY;
  const seconds = [...steps].reverse().map((step) => {
    const at = seen[step.key];
    if (step.state !== 'done' || at === undefined) return null;
    later = Math.min(later, (at - startedAt) / 1000);
    return later;
  }).reverse();
  return steps.map((step, i) => (step.state === 'active' ? 'now' : seconds[i] === null || seconds[i] === undefined ? null : clockOf(seconds[i])));
}

export function minutesLeft(elapsedSeconds: number): number | null {
  const left = TYPICAL_SECONDS - elapsedSeconds;
  return left <= 0 ? null : Math.max(1, Math.ceil(left / 60));
}

export function timeLeftLine(elapsedSeconds: number): string {
  const minutes = minutesLeft(elapsedSeconds);
  if (minutes === null) return 'Taking a little longer than usual. You can close this page.';
  return `About ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} left. You can close this page.`;
}

export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

const REGION_ZONES: Record<string, string[]> = {
  'eu-central-2': ['Europe', 'Africa', 'Asia', 'Atlantic', 'Indian', 'Arctic'],
  'us-east-1': ['America', 'US', 'Canada', 'Pacific', 'Brazil', 'Mexico', 'Chile'],
};

export function closestRegion(regions: string[], timeZone: string): string | null {
  const area = timeZone.split('/')[0] ?? '';
  return regions.find((code) => (REGION_ZONES[code] ?? []).includes(area)) ?? regions[0] ?? null;
}

export function cityOf(regionName: string): string {
  return /\(([^)]+)\)/.exec(regionName)?.[1] ?? regionName;
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

interface LaunchFailure {
  text: string;
  elsewhere: boolean;
}

export function launchFailure(message: string, place: string): LaunchFailure {
  if (/InsufficientInstanceCapacity|insufficient capacity/i.test(message)) return { text: `AWS has no free servers of this size in ${place} right now.`, elsewhere: true };
  if (/Unsupported|not supported in your requested Availability Zone/i.test(message)) return { text: `AWS does not offer this server size in ${place}.`, elsewhere: true };
  if (/VcpuLimitExceeded|InstanceLimitExceeded/i.test(message)) return { text: 'AWS will not start more servers for this account right now.', elsewhere: false };
  if (/RequestLimitExceeded|Throttl/i.test(message)) return { text: 'AWS is busy. Try again in a minute.', elsewhere: false };
  return { text: sentence(message), elsewhere: false };
}

const launchRefused = (status: number | null): boolean => status === 400 || status === 503;

interface LaunchRefusal extends LaunchFailure {
  refused: boolean;
}

export function refusalOf(message: string, place: string, status: number | null): LaunchRefusal {
  if (!launchRefused(status)) return { text: `${sentence(message)} Check your agents before you try again.`, elsewhere: false, refused: false };
  const failure = launchFailure(message, place);
  return { text: `${failure.text} No server was started, so nothing was charged.`, elsewhere: failure.elsewhere, refused: true };
}

const ENDED = new Set(['terminated', 'shutting-down']);
const PAUSED = new Set(['stopped', 'stopping']);

export function failedLaunchNote(instance: string | null, canDelete: boolean): string {
  const state = instance ?? '';
  if (ENDED.has(state)) return `AWS ended the server, so it is no longer billed. ${canDelete ? 'Delete removes it from your agents.' : 'Ask an admin of the organization to remove it from your agents.'}`;
  const billed = PAUSED.has(state) ? 'The server is stopped in AWS, but its disk is billed until you delete it.' : 'The server is still running in AWS and is billed until you delete it.';
  return `${billed} ${canDelete ? 'Delete removes the server and its disk from AWS.' : 'Ask an admin of the organization to delete it.'}`;
}
