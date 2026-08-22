const FAVICON_BASE = 'https://www.google.com/s2/favicons';

const MULTI_LABEL_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'me.uk', 'net.uk', 'org.uk',
  'com.au', 'edu.au', 'net.au', 'org.au',
  'co.nz', 'net.nz', 'org.nz',
  'ac.jp', 'co.jp', 'ne.jp', 'or.jp',
  'co.kr', 'co.za', 'co.il', 'co.in', 'net.in', 'org.in',
  'com.ar', 'com.br', 'net.br', 'org.br',
  'com.cn', 'net.cn', 'org.cn',
  'com.hk', 'com.mx', 'com.pl', 'com.sg', 'com.tr', 'com.tw',
]);

export function baseDomain(host: string): string {
  const labels = host
    .toLowerCase()
    .replace(/\.$/, '')
    .split('.')
    .filter((label) => label !== '');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

export function faviconUrl(url: string, size = 32): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  const domain = baseDomain(host);
  if (domain === '' || !domain.includes('.')) return '';
  return `${FAVICON_BASE}?domain=${encodeURIComponent(domain)}&sz=${String(size)}`;
}
