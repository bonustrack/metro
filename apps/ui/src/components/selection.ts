export type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'station'; accountId: string }
  | { kind: 'connectors' }
  | { kind: 'connector'; id: string }
  | { kind: 'collections' }
  | { kind: 'collection'; id: string }
  | { kind: 'authorize' }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'none' };
