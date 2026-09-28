export interface MailHeader {
  name?: string;
  value?: string;
}

export type Screened = { skip: string } | { verified: boolean };

const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|notifications?)([+._-].*)?$/i;
const BULK = new Set(['bulk', 'list', 'junk']);

export const headerValues = (headers: MailHeader[], name: string): string[] =>
  headers.filter((h) => (h.name ?? '').toLowerCase() === name).map((h) => (h.value ?? '').trim());

export const firstHeader = (headers: MailHeader[], name: string): string | undefined => headerValues(headers, name)[0];

export function automatedBySender(address: string): string | null {
  const local = address.split('@')[0] ?? '';
  return AUTOMATED_LOCAL.test(local) ? `sender ${address}` : null;
}

export function automatedByHeaders(headers: MailHeader[]): string | null {
  if (firstHeader(headers, 'list-unsubscribe') !== undefined) return 'List-Unsubscribe';
  const auto = firstHeader(headers, 'auto-submitted');
  if (auto !== undefined && auto.toLowerCase() !== 'no') return `Auto-Submitted: ${auto}`;
  const precedence = (firstHeader(headers, 'precedence') ?? '').toLowerCase();
  return BULK.has(precedence) ? `Precedence: ${precedence}` : null;
}

export const domainOf = (address: string): string => (address.split('@')[1] ?? '').toLowerCase();
