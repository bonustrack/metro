export type Selection =
  | { kind: 'agent'; id: number }
  | { kind: 'new' }
  | { kind: 'start' }
  | { kind: 'runs' }
  | { kind: 'none' };
