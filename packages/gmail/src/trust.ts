import { automatedByHeaders, automatedBySender, domainOf, firstHeader, type MailHeader, type Screened } from '@metro-labs/core/stations/mail-trust';

const DMARC = /^dmarc=(\w+) header\.from=([a-z0-9.-]+)$/;
const DKIM_PASS = /^dkim=pass((?: header\.[a-z]+=[^\s"()]+)+)$/;
const DKIM_DOMAIN = / header\.(?:i=[^@\s]*@|d=)([a-z0-9.-]+)(?= |$)/g;

function withoutComments(text: string): string {
  let out = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(/\([^()]*\)/g, ' ');
  }
  return out;
}

function clausesOf(result: string): string[] | null {
  const clauses = withoutComments(result)
    .split(';')
    .map((c) => c.replace(/\s+/g, ' ').trim().toLowerCase());
  return clauses[0] === 'mx.google.com' ? clauses.slice(1) : null;
}

const dkimAligned = (clauses: string[], fromDomain: string): boolean =>
  clauses.some((c) => [...(DKIM_PASS.exec(c)?.[1] ?? '').matchAll(DKIM_DOMAIN)].some((m) => m[1] === fromDomain));

function passes(clauses: string[], fromDomain: string): boolean {
  const dmarc = clauses.map((c) => DMARC.exec(c)).find((m) => m !== null);
  if (dmarc?.[2] !== undefined && dmarc[2] !== fromDomain) return false;
  if (dmarc?.[1] === 'pass') return true;
  return dmarc?.[1] !== 'fail' && dkimAligned(clauses, fromDomain);
}

export function senderVerified(headers: MailHeader[], fromAddress: string): boolean {
  const fromDomain = domainOf(fromAddress);
  const clauses = clausesOf(firstHeader(headers, 'authentication-results') ?? '');
  return fromDomain !== '' && clauses !== null && passes(clauses, fromDomain);
}

export function screen(headers: MailHeader[], from: string, keepAutomated: boolean): Screened {
  const automated = keepAutomated ? null : (automatedBySender(from) ?? automatedByHeaders(headers));
  return automated === null ? { verified: senderVerified(headers, from) } : { skip: automated };
}
