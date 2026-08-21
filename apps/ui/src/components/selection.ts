export type Selection =
  | { kind: 'agent'; id: number }
  | { kind: 'station'; accountId: string }
  | { kind: 'connectors' }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'none' };
