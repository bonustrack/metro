import { flattenAccounts, stationFields, type AccountGroup, type FlatAccount } from '@metro-labs/client/api/accounts';
import { stationLabel } from '@metro-labs/client/api/attach';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { providerLabel, routedConnection } from '@metro-labs/client/api/providers';
import type { Selection } from '@metro-labs/client/selection';

export type StepId = 'model' | 'chat' | 'write' | 'approve' | 'hello';

export interface SetupStep {
  id: StepId;
  title: string;
  hint: string;
  done: boolean;
  target: Selection;
}

export interface SetupInput {
  name: string;
  project: string;
  model: ModelSettings | undefined;
  groups: AccountGroup[] | undefined;
  conversations: number | undefined;
  link?: string | null;
}

export interface Setup {
  steps: SetupStep[];
  done: number;
  open: SetupStep | null;
}

const NO_APPROVALS = new Set(['outlook', 'gmail', 'webhook']);

const chats = (groups: AccountGroup[]): FlatAccount[] => flattenAccounts(groups).filter((a) => a.station !== 'webhook');

export const modelReady = (model: ModelSettings): boolean => model.ready || (model.route !== null && model.reason === null);

function connectionName(model: ModelSettings): string {
  const conn = routedConnection(model);
  if (conn === undefined) return 'No model yet';
  return conn.label === '' ? providerLabel(conn.provider) : conn.label;
}

function modelStep(input: SetupInput, model: ModelSettings): SetupStep {
  const done = modelReady(model);
  const hint = done ? connectionName(model) : input.link ?? model.reason ?? `Pick the AI behind ${input.name}`;
  return { id: 'model', title: 'Choose a model', hint, done, target: { kind: 'model', project: input.project } };
}

export function accountName(account: FlatAccount): string {
  const handle = stationFields(account.row).handle ?? account.row.id ?? '';
  return [stationLabel(account.station), handle].filter((part) => part !== '').join(' · ');
}

function chatStep(input: SetupInput, accounts: FlatAccount[]): SetupStep {
  const first = accounts[0];
  const hint = first === undefined ? `Where your team writes to ${input.name}: WhatsApp, Outlook, Telegram…` : accountName(first);
  return { id: 'chat', title: 'Connect a channel', hint, done: first !== undefined, target: { kind: 'chats', project: input.project } };
}

const pageOf = (input: SetupInput, account: FlatAccount | undefined): Selection =>
  account === undefined || account.row.id === null
    ?{ kind: 'chats', project: input.project }
    : { kind: 'station', project: input.project, accountId: account.row.id };

function writeStep(input: SetupInput, accounts: FlatAccount[]): SetupStep {
  const done = accounts.some((a) => a.row.allowlist !== null);
  const target = pageOf(input, accounts.find((a) => a.row.allowlist === null));
  return { id: 'write', title: 'Who can write', hint: `Pick who ${input.name} answers. Everyone else is ignored.`, done, target };
}

const settled = (account: FlatAccount): boolean =>
  account.row.approvers.length > 0 || (account.row.allowlist?.includes('*') ?? false);

function approveStep(input: SetupInput, accounts: FlatAccount[]): SetupStep {
  const target = pageOf(input, accounts.find((a) => a.row.allowlist !== null && !settled(a)) ?? accounts[0]);
  return { id: 'approve', title: 'Who can approve', hint: `Who says yes when ${input.name} asks first`, done: accounts.some(settled), target };
}

function helloStep(input: SetupInput, conversations: number): SetupStep {
  return { id: 'hello', title: 'Say hello', hint: 'Send a first message to check it answers', done: conversations > 0, target: { kind: 'chats', project: input.project } };
}

export function setupOf(input: SetupInput): Setup {
  const steps: SetupStep[] = [];
  if (input.model !== undefined) steps.push(modelStep(input, input.model));
  if (input.groups !== undefined) {
    const accounts = chats(input.groups);
    const approving = accounts.filter((a) => !NO_APPROVALS.has(a.station));
    steps.push(chatStep(input, accounts), writeStep(input, accounts));
    if (accounts.length === 0 || approving.length > 0) steps.push(approveStep(input, approving));
  }
  if (input.conversations !== undefined) steps.push(helloStep(input, input.conversations));
  return { steps, done: steps.filter((step) => step.done).length, open: steps.find((step) => !step.done) ?? null };
}
