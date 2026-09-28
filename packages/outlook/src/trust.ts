import { automatedByHeaders, automatedBySender, domainOf, firstHeader, headerValues, type MailHeader, type Screened } from '@metro-labs/core/stations/mail-trust';
import type { Account } from './accounts.js';
import { addressOf, type GraphMessage } from './format.js';
import { graphJson, messagePath } from './graph.js';

function headerFrom(result: string): string | null {
  return /header\.from=([^\s;]+)/i.exec(result)?.[1]?.toLowerCase() ?? null;
}

function passes(result: string, fromDomain: string): boolean {
  const aligned = headerFrom(result);
  if (aligned !== null && aligned !== fromDomain) return false;
  if (/\bdmarc=pass\b/i.test(result)) return true;
  return /\bcompauth=pass\b/i.test(result) && aligned === fromDomain;
}

export function senderVerified(headers: MailHeader[], fromAddress: string): boolean {
  if ((firstHeader(headers, 'x-ms-exchange-organization-authas') ?? '').toLowerCase() === 'internal') return true;
  const fromDomain = domainOf(fromAddress);
  if (fromDomain === '') return false;
  const ours = firstHeader(headers, 'authentication-results');
  if (ours !== undefined && passes(ours, fromDomain)) return true;
  const arc = headerValues(headers, 'arc-authentication-results').find((v) => /\bmx\.microsoft\.com\b/i.test(v));
  return arc !== undefined && passes(arc, fromDomain);
}

async function headersOf(acct: Account, messageId: string): Promise<MailHeader[]> {
  const m = await graphJson<{ internetMessageHeaders?: MailHeader[] }>(acct, `${messagePath(messageId)}?$select=internetMessageHeaders`);
  return m.internetMessageHeaders ?? [];
}

export async function screen(acct: Account, m: GraphMessage): Promise<Screened> {
  const from = addressOf(m.from);
  const keepAutomated = acct.cfg.includeAutomated === true;
  const bySender = keepAutomated ? null : automatedBySender(from);
  if (bySender !== null) return { skip: bySender };
  const headers = await headersOf(acct, m.id);
  const byHeaders = keepAutomated ? null : automatedByHeaders(headers);
  if (byHeaders !== null) return { skip: byHeaders };
  return { verified: senderVerified(headers, from) };
}
