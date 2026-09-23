import type { Account } from './accounts.js';
import { addressOf, type GraphMessage } from './format.js';
import { graphJson, messagePath } from './graph.js';

export interface Header {
  name?: string;
  value?: string;
}

export type Screened = { skip: string } | { verified: boolean };

const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|notifications?)([+._-].*)?$/i;
const BULK = new Set(['bulk', 'list', 'junk']);

const valuesOf = (headers: Header[], name: string): string[] =>
  headers.filter((h) => (h.name ?? '').toLowerCase() === name).map((h) => (h.value ?? '').trim());

const first = (headers: Header[], name: string): string | undefined => valuesOf(headers, name)[0];

export function automatedBySender(address: string): string | null {
  const local = address.split('@')[0] ?? '';
  return AUTOMATED_LOCAL.test(local) ? `sender ${address}` : null;
}

export function automatedByHeaders(headers: Header[]): string | null {
  if (first(headers, 'list-unsubscribe') !== undefined) return 'List-Unsubscribe';
  const auto = first(headers, 'auto-submitted');
  if (auto !== undefined && auto.toLowerCase() !== 'no') return `Auto-Submitted: ${auto}`;
  const precedence = (first(headers, 'precedence') ?? '').toLowerCase();
  return BULK.has(precedence) ? `Precedence: ${precedence}` : null;
}

const domainOf = (address: string): string => (address.split('@')[1] ?? '').toLowerCase();

function headerFrom(result: string): string | null {
  return /header\.from=([^\s;]+)/i.exec(result)?.[1]?.toLowerCase() ?? null;
}

function passes(result: string, fromDomain: string): boolean {
  const aligned = headerFrom(result);
  if (aligned !== null && aligned !== fromDomain) return false;
  if (/\bdmarc=pass\b/i.test(result)) return true;
  return /\bcompauth=pass\b/i.test(result) && aligned === fromDomain;
}

export function senderVerified(headers: Header[], fromAddress: string): boolean {
  if ((first(headers, 'x-ms-exchange-organization-authas') ?? '').toLowerCase() === 'internal') return true;
  const fromDomain = domainOf(fromAddress);
  if (fromDomain === '') return false;
  const ours = first(headers, 'authentication-results');
  if (ours !== undefined && passes(ours, fromDomain)) return true;
  const arc = valuesOf(headers, 'arc-authentication-results').find((v) => /\bmx\.microsoft\.com\b/i.test(v));
  return arc !== undefined && passes(arc, fromDomain);
}

async function headersOf(acct: Account, messageId: string): Promise<Header[]> {
  const m = await graphJson<{ internetMessageHeaders?: Header[] }>(acct, `${messagePath(messageId)}?$select=internetMessageHeaders`);
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
