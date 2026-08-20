export type Selection =
  | { kind: 'agent'; id: number }
  | { kind: 'station'; accountId: string }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'none' };
