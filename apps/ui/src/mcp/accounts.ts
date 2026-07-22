export interface AccountField {
  label: string;
  value: string;
}

export interface AccountRow {
  fields: AccountField[];
}

export interface AccountGroup {
  station: string;
  rows: AccountRow[];
}

const SECRET_KEY_PATTERN =
  /(token|secret|key|mnemonic|private|session|apihash|apiid|cred|password|derive|passphrase|seed)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 0 ? value : '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).join(', ');
  return JSON.stringify(value);
}

function toRow(account: unknown): AccountRow {
  if (!isRecord(account)) return { fields: [{ label: 'value', value: stringifyValue(account) }] };
  const fields: AccountField[] = [];
  for (const [key, value] of Object.entries(account)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    fields.push({ label: key, value: stringifyValue(value) });
  }
  return { fields };
}

function toGroups(accounts: Record<string, unknown>): AccountGroup[] {
  const groups: AccountGroup[] = [];
  for (const [station, list] of Object.entries(accounts)) {
    const rows = Array.isArray(list) ? list.map(toRow) : [];
    groups.push({ station, rows });
  }
  return groups.sort((a, b) => a.station.localeCompare(b.station));
}

export class ListAccountsError extends Error {}

function firstTextBlock(content: unknown): string {
  if (!Array.isArray(content)) throw new ListAccountsError('list_accounts returned no content');
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  throw new ListAccountsError('list_accounts returned no text content');
}

export function parseListAccounts(result: unknown): AccountGroup[] {
  if (!isRecord(result)) throw new ListAccountsError('unexpected list_accounts result');
  if (result.isError === true) {
    throw new ListAccountsError(firstTextBlock(result.content));
  }
  const payload: unknown = JSON.parse(firstTextBlock(result.content));
  if (!isRecord(payload) || !isRecord(payload.accounts)) {
    throw new ListAccountsError('list_accounts payload missing accounts');
  }
  return toGroups(payload.accounts);
}
