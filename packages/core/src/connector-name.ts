import { brandName } from './brands.js';
import { baseDomain } from './favicon.js';

const GENERIC = new Set(['mcp', 'api', 'www', 'app', 'server', 'servers', 'remote', 'connect', 'gateway']);
const NAME_MAX = 64;
const WORD_BREAK = /[\s_.-]+/;

const capital = (word: string): string => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

const isGeneric = (label: string): boolean => GENERIC.has(label.toLowerCase());

function hostOf(address: string): string | null {
  try {
    const host = new URL(address.trim()).hostname.toLowerCase();
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

function guessOf(host: string): string {
  const labels = host.split('.').filter((label) => label !== '');
  const base = baseDomain(host).split('.');
  const sub = labels.slice(0, Math.max(0, labels.length - base.length));
  const named = sub.filter((label) => !isGeneric(label));
  const [first] = sub;
  const [product] = named;
  if (first !== undefined && isGeneric(first) && product !== undefined) return product;
  const company = base.length > 1 ? base[0] : labels[0];
  if (company !== undefined && !isGeneric(company)) return company;
  return named.at(-1) ?? labels[0] ?? '';
}

export function connectorNameGuess(address: string): string {
  const host = hostOf(address);
  if (host === null) return '';
  return brandName(`https://${host}`) ?? capital(guessOf(host));
}

export interface ServerNames {
  title?: string;
  name?: string;
}

export function productName(server: ServerNames, address: string): string {
  const title = (server.title ?? '').trim();
  if (title !== '') return title.slice(0, NAME_MAX);
  const words = (server.name ?? '').split(WORD_BREAK).filter((word) => word !== '' && !isGeneric(word));
  if (words.length > 0) return words.map((word) => (word === word.toLowerCase() ? capital(word) : word)).join(' ').slice(0, NAME_MAX);
  return connectorNameGuess(address);
}

export function accountConnectorName(product: string, account: string): string {
  const full = product === '' ? account : `${product} (${account})`;
  return full.length <= NAME_MAX ? full : account.slice(0, NAME_MAX);
}
