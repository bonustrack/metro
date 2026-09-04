const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

export function shortAddress(value: string): string {
  if (!isAddress(value)) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
