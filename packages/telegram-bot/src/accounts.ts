import {
  makeAccountStore,
  resolveAccountId,
} from '@metro-labs/core/stations/account-store';
import { Line } from '@metro-labs/core/lines';

export interface AccountConfig {
  id: string;
  token: string;
}

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'telegram-bot',
  validate(raw, die) {
    const seenTok = new Set<string>();
    for (const a of raw) {
      if (!a.token || typeof a.token !== 'string')
        die(`account '${a.id}' missing token`);
      if (seenTok.has(a.token))
        die(
          `account '${a.id}' reuses a token used by another account (409 on getUpdates)`,
        );
      seenTok.add(a.token);
    }
  },
});

export interface Account {
  cfg: AccountConfig;
  api: string;
  fileApi: string;
  offset: number;
  username?: string;
}
export const accounts = new Map<string, Account>();

export async function tg<T>(
  accountId: string,
  method: string,
  body: unknown,
  timeoutMs = body instanceof FormData ? 60_000 : 30_000,
): Promise<T> {
  const acct = accounts.get(accountId);
  if (!acct) throw new Error(`unknown account '${accountId}'`);
  const form = body instanceof FormData;
  const res = await fetch(`${acct.api}/${method}`, {
    method: 'POST',
    ...(form ? {} : { headers: { 'Content-Type': 'application/json' } }),
    body: form ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: T;
  };
  if (!json.ok)
    throw new Error(`telegram-bot ${method}: ${json.description ?? 'unknown'}`);
  return json.result as T;
}

export function accountFor(args: { account?: string; line?: string }): string {
  return resolveAccountId(
    accounts,
    args,
    (line) => Line.parseTelegram(line)?.accountId,
  );
}

export function lineOf(
  accountId: string,
  chatId: number | string,
  topicId?: number,
): string {
  const tail = topicId !== undefined ? `${chatId}/${topicId}` : `${chatId}`;
  return `metro://telegram-bot/${accountId}/${tail}`;
}

export function targetOf(
  line: string,
  accountOverride?: string,
): { accountId: string; chatId: number; topicId?: number } {
  const parsed = Line.parseTelegram(line);
  if (!parsed) throw new Error(`bad telegram-bot line: ${line}`);
  return { ...parsed, accountId: accountOverride ?? parsed.accountId };
}
