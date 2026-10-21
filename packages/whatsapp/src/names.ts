import { readFileSync } from 'node:fs';
import { accountFiles } from '@metro-labs/core/stations/account-files';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';

const MAX_NAMES = 2000;
const SAVE_DELAY_MS = 2000;

export const nameFiles = accountFiles('WHATSAPP_TOKEN_DIR', 'whatsapp-names-');

export interface NameBook {
  note(jid: string | null | undefined, name: string | null | undefined): void;
  get(jid: string): string | undefined;
  alias(pn: string | null | undefined, lid: string | null | undefined): void;
}

function loaded(file: string | undefined): Map<string, string> {
  if (file === undefined) return new Map();
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(raw)) return new Map();
    return new Map(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
  } catch {
    return new Map();
  }
}

const JID_RE = /^([^@:_]+)(?:_\d+)?(?::\d+)?@([^@]+)$/;

export function idOf(jid: string | null | undefined): string | undefined {
  const parts = JID_RE.exec(jid ?? '');
  if (parts === null) return undefined;
  const [, user = '', server = ''] = parts;
  return `${user}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

export function makeNameBook(file?: string): NameBook {
  const names = loaded(file);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    timer = null;
    if (file === undefined) return;
    try {
      writeSecure(file, JSON.stringify(Object.fromEntries(names)));
    } catch (err) {
      process.stderr.write(`whatsapp: could not save the names: ${errMsg(err)}\n`);
    }
  };
  const schedule = (): void => {
    if (file !== undefined && timer === null) {
      timer = setTimeout(save, SAVE_DELAY_MS);
      timer.unref();
    }
  };
  const note = (raw: string | null | undefined, name: string | null | undefined): void => {
    const clean = name?.trim() ?? '';
    const jid = idOf(raw);
    if (jid === undefined || clean === '' || names.get(jid) === clean) return;
    names.delete(jid);
    names.set(jid, clean);
    if (names.size > MAX_NAMES) {
      const oldest = names.keys().next().value;
      if (oldest !== undefined) names.delete(oldest);
    }
    schedule();
  };
  return {
    note,
    get: (jid) => names.get(idOf(jid) ?? jid),
    alias(rawPn, rawLid) {
      const pn = idOf(rawPn);
      const lid = idOf(rawLid);
      if (pn === undefined || lid === undefined) return;
      const known = names.get(pn) ?? names.get(lid);
      if (!names.has(pn)) note(pn, known);
      if (!names.has(lid)) note(lid, known);
    },
  };
}

export interface ContactNames {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

const nonBlank = (value: string | null | undefined): string | undefined => (value?.trim() ? value : undefined);

const isLid = (jid: string | null | undefined): jid is string => jid?.endsWith('@lid') === true;

export function noteContact(book: NameBook, c: ContactNames): void {
  const name = nonBlank(c.name) ?? nonBlank(c.notify) ?? nonBlank(c.verifiedName);
  for (const jid of [c.id, c.lid, c.phoneNumber]) book.note(jid, name);
  const lid = c.lid ?? (isLid(c.id) ? c.id : undefined);
  const pn = c.phoneNumber ?? (isLid(c.id) ? undefined : c.id);
  book.alias(pn, lid);
}

export const phoneOf = (jid: string | null | undefined): string | undefined => {
  const digits = /^(\d{6,})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')?.[1];
  return digits === undefined ? undefined : `+${digits}`;
};
