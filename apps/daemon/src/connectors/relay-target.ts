export type RelayTarget =
  | { kind: 'ok'; url: string; headers: Record<string, string> }
  | { kind: 'missing' }
  | { kind: 'signin' };
