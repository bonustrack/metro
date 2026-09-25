import { isRecord } from './read.js';
import { policyOf, type ToolPolicy } from './policy.js';
interface AccountField {
  label: string;
  value: string;
}

export interface AccountRow {
  id: string | null;
  allowlist: string[] | null;
  approvers: string[];
  enabled: boolean;
  policy: ToolPolicy;
  fields: AccountField[];
}

export const EVERYONE = '*';

export const allowsEveryone = (allowlist: string[] | null): boolean =>
  allowlist === null || allowlist.length === 0 || allowlist.includes(EVERYONE);

function allowlistOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export interface AccountGroup {
  station: string;
  rows: AccountRow[];
  stale?: boolean;
}

const SECRET_KEY_PATTERN =
  /(token|secret|key|mnemonic|private|session|apihash|apiid|cred|password|derive|passphrase|seed)/i;

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value.length > 0 ? value : '-';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).join(', ');
  return JSON.stringify(value);
}

const AGENT_ID = 'agentId';
const ALLOWLIST = 'allowlist';
const APPROVERS = 'approvers';
const ENABLED = 'enabled';
const POLICY = 'policy';
const HIDDEN_KEYS = new Set([AGENT_ID, ALLOWLIST, APPROVERS, ENABLED, POLICY]);

function toRow(account: unknown): AccountRow {
  if (!isRecord(account))
    return {
      id: null,
      allowlist: null,
      approvers: [],
      enabled: true,
      policy: {},
      fields: [{ label: 'value', value: stringifyValue(account) }],
    };
  const fields: AccountField[] = [];
  for (const [key, value] of Object.entries(account)) {
    if (HIDDEN_KEYS.has(key) || SECRET_KEY_PATTERN.test(key)) continue;
    fields.push({ label: key, value: stringifyValue(value) });
  }
  return {
    id: typeof account.id === 'string' ? account.id : null,
    allowlist: allowlistOf(account[ALLOWLIST]),
    approvers: allowlistOf(account[APPROVERS]) ?? [],
    enabled: account[ENABLED] !== false,
    policy: policyOf(account[POLICY]),
    fields,
  };
}

export function groupAccounts(accounts: unknown): AccountGroup[] {
  if (!isRecord(accounts)) return [];
  const groups: AccountGroup[] = [];
  for (const [station, list] of Object.entries(accounts)) {
    const rows = Array.isArray(list) ? list.map(toRow) : [];
    groups.push({ station, rows });
  }
  return groups.sort((a, b) => a.station.localeCompare(b.station));
}

export interface FlatAccount {
  station: string;
  row: AccountRow;
  stale: boolean;
}

export function flattenAccounts(groups: AccountGroup[]): FlatAccount[] {
  const out: FlatAccount[] = [];
  for (const group of groups)
    for (const row of group.rows)
      out.push({ station: group.station, row, stale: group.stale === true });
  return out;
}

const IDENTITY = new Set(['id', 'handle', 'url', 'endpoint', 'callback']);

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === '' || value === '-' ? undefined : value;

export interface StationFields {
  handle: string | undefined;
  url: string | undefined;
  endpoint: string | undefined;
  callback: string | undefined;
  details: AccountField[];
}

export function stationFields(row: AccountRow): StationFields {
  const pick = (label: string): string | undefined =>
    present(row.fields.find((f) => f.label === label)?.value);
  return {
    handle: pick('handle'),
    url: pick('url'),
    endpoint: pick('endpoint'),
    callback: pick('callback'),
    details: row.fields.filter(
      (f) => !IDENTITY.has(f.label) && present(f.value) !== undefined,
    ),
  };
}

export function findAccount(
  groups: AccountGroup[],
  accountId: string,
): FlatAccount | undefined {
  return flattenAccounts(groups).find((a) => a.row.id === accountId);
}

export function carryForward(
  next: AccountGroup[],
  prev: AccountGroup[],
  unavailable: string[],
): AccountGroup[] {
  if (unavailable.length === 0) return next;
  const kept = prev
    .filter((g) => unavailable.includes(g.station))
    .filter((g) => g.rows.length > 0)
    .map((g) => ({ ...g, stale: true }));
  const fresh = next.filter((g) => !unavailable.includes(g.station));
  return [...fresh, ...kept].sort((x, y) => x.station.localeCompare(y.station));
}
