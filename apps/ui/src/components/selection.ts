export type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'station'; accountId: string }
  | { kind: 'connectors' }
  | { kind: 'connector'; id: string }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'none' };
