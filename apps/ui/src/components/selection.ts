export type Selection =
  | { kind: 'agent'; id: number }
  | { kind: 'new' }
  | { kind: 'none' };
