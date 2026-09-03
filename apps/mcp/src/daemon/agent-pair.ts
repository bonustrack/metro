import { makeCodeStore } from './pair-codes.js';

export interface AgentCode {
  subject: string;
  agentId: string;
}

const store = makeCodeStore<AgentCode>('ma');

export const AGENT_CODE_RE = store.pattern;

export const mintAgentCode = (
  entry: AgentCode,
  now?: number,
): { code: string; expiresAt: number } => store.mint(entry, now);

export const takeAgentCode = (code: string, now?: number): AgentCode | undefined =>
  store.take(code, now);

export const agentCodeCount = (): number => store.count();
