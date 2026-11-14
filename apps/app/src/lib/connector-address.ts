import { connectorNameGuess } from '@metro-labs/core/connector-name';

export const nameFromAddress = (address: string): string => connectorNameGuess(address);

export function connectorNaming(address: string, typed: string): { name: string; autoName: boolean } {
  const guess = nameFromAddress(address);
  const name = typed.trim();
  return name === '' || name === guess ? { name: guess, autoName: true } : { name, autoName: false };
}

export function addressProblem(address: string): string | null {
  const text = address.trim();
  if (text === '') return 'Paste the address first.';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use a web address that starts with https://.';
    return url.hostname === '' ? 'That address has no server name.' : null;
  } catch {
    return 'Use a full address that starts with https://.';
  }
}
