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
  return {
    note(jid, name) {
      const clean = name?.trim() ?? '';
      if (!jid || clean === '' || names.get(jid) === clean) return;
      names.delete(jid);
      names.set(jid, clean);
      if (names.size > MAX_NAMES) {
        const oldest = names.keys().next().value;
        if (oldest !== undefined) names.delete(oldest);
      }
      if (file !== undefined && timer === null) {
        timer = setTimeout(save, SAVE_DELAY_MS);
        timer.unref();
      }
    },
    get: (jid) => names.get(jid),
  };
}

export interface ContactNames {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
}

export function noteContact(book: NameBook, c: ContactNames): void {
  const name = c.name ?? c.notify;
  for (const jid of [c.id, c.lid, c.phoneNumber]) book.note(jid, name);
}

export const phoneOf = (jid: string | null | undefined): string | undefined => {
  const digits = /^(\d{6,})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')?.[1];
  return digits === undefined ? undefined : `+${digits}`;
};
