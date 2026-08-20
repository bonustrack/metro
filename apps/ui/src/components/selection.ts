export type Selection =
  | { kind: 'agent'; id: number }
  | { kind: 'docs' }
  | { kind: 'settings' }
  | { kind: 'none' };
