import { accountFromLine, agentIdForAccount } from '../db/agent-map.js';

const accountStrippedLine = (line: string): string => {
  const parts = line.split('/');
  if (parts.length < 5) return line;
  return [parts[0], parts[1], parts[2], ...parts.slice(4)].join('/');
};

export const dedupeOwner = (line: string): string => {
  const acct = accountFromLine(line);
  if (!acct) return 'unowned';
  const agentId = agentIdForAccount(acct.station, acct.accountId);
  return agentId === undefined
    ? `account:${acct.accountId}`
    : `agent:${agentId}`;
};

export const dedupeKey = (
  e: { station: string; line: string; from: string; variant: string },
  messageId: string,
): string =>
  [
    dedupeOwner(e.line),
    e.station,
    accountStrippedLine(e.line),
    accountStrippedLine(e.from),
    e.variant,
    messageId,
  ].join(' ');
