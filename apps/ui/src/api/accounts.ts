export interface AccountField {
  label: string;
  value: string;
}

export interface AccountRow {
  id: string | null;
  agentId: number | null;
  fields: AccountField[];
}

export interface AccountGroup {
  station: string;
  rows: AccountRow[];
}

const SECRET_KEY_PATTERN =
  /(token|secret|key|mnemonic|private|session|apihash|apiid|cred|password|derive|passphrase|seed)/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value.length > 0 ? value : '-';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).join(', ');
  return JSON.stringify(value);
}

const AGENT_ID = 'agentId';

function toRow(account: unknown): AccountRow {
  if (!isRecord(account))
    return {
      id: null,
      agentId: null,
      fields: [{ label: 'value', value: stringifyValue(account) }],
    };
  const fields: AccountField[] = [];
  for (const [key, value] of Object.entries(account)) {
    if (key === AGENT_ID || SECRET_KEY_PATTERN.test(key)) continue;
    fields.push({ label: key, value: stringifyValue(value) });
  }
  const owner = account[AGENT_ID];
  return {
    id: typeof account.id === 'string' ? account.id : null,
    agentId: typeof owner === 'number' ? owner : null,
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

export function attributeUntagged(
  groups: AccountGroup[],
  agentId: number,
): AccountGroup[] {
  return groups.map((g) => ({
    station: g.station,
    rows: g.rows.map((r) => (r.agentId === null ? { ...r, agentId } : r)),
  }));
}

export function accountsForAgent(
  groups: AccountGroup[],
  agentId: number,
): AccountGroup[] {
  const out: AccountGroup[] = [];
  for (const g of groups) {
    const rows = g.rows.filter((r) => r.agentId === agentId);
    if (rows.length > 0) out.push({ station: g.station, rows });
  }
  return out;
}

export interface FlatAccount {
  station: string;
  row: AccountRow;
}

export function flattenAccounts(groups: AccountGroup[]): FlatAccount[] {
  const out: FlatAccount[] = [];
  for (const group of groups)
    for (const row of group.rows) out.push({ station: group.station, row });
  return out;
}

const IDENTITY = new Set(['id', 'handle', 'url', 'endpoint']);

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === '' || value === '-' ? undefined : value;

export interface StationFields {
  handle: string | undefined;
  url: string | undefined;
  endpoint: string | undefined;
  details: AccountField[];
}

export function stationFields(row: AccountRow): StationFields {
  const pick = (label: string): string | undefined =>
    present(row.fields.find((f) => f.label === label)?.value);
  return {
    handle: pick('handle'),
    url: pick('url'),
    endpoint: pick('endpoint'),
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
  dropped: string[],
): AccountGroup[] {
  if (unavailable.length === 0) return next;
  const kept = prev
    .filter((g) => unavailable.includes(g.station))
    .map((g) => ({
      station: g.station,
      rows: g.rows.filter((r) => !dropped.includes(`${g.station}/${r.id ?? ''}`)),
    }))
    .filter((g) => g.rows.length > 0);
  const fresh = next.filter((g) => !unavailable.includes(g.station));
  return [...fresh, ...kept].sort((x, y) => x.station.localeCompare(y.station));
}

export function unattributedAccounts(groups: AccountGroup[]): number {
  return groups.reduce(
    (n, g) => n + g.rows.filter((r) => r.agentId === null).length,
    0,
  );
}
