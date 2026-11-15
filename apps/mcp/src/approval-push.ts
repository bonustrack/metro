import { and, eq } from 'drizzle-orm';
import type { Database } from '@metro-labs/connectors/db/database';
import { queuePush, type PushRequest } from '@metro-labs/connectors/db/push-outbox';
import { agents } from '@metro-labs/connectors/db/schema';
import { approvalLink } from '@metro-labs/http/approval-rules';

const TEXT_MAX = 120;

export interface AskedApproval {
  id: string;
  owner: string;
  agent: string;
  tool: string;
  connector: string;
}

export interface ApprovalPush {
  asked: (asked: AskedApproval) => Promise<void>;
}

interface ApprovalPushSetup {
  db: () => Database;
  appUrl: string;
  now: () => number;
}

const short = (text: string): string => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text);

export function approvalNote(agentName: string | null, asked: AskedApproval, appUrl: string): PushRequest {
  const name = agentName === null || agentName.trim() === '' ? 'Your agent' : agentName.trim();
  return { owner: asked.owner, agent: asked.agent, approval: asked.id, title: short(`${name} needs your approval`), body: short(`${asked.tool} on ${asked.connector}`), url: approvalLink(appUrl, { owner: asked.owner, agent: asked.agent }, asked.id) };
}

async function agentName(db: Database, owner: string, agent: string): Promise<string | null> {
  const rows = await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, agent), eq(agents.owner, owner))).limit(1);
  return rows[0]?.name ?? null;
}

export function approvalPush(setup: ApprovalPushSetup): ApprovalPush {
  return {
    asked: async (asked) => {
      const db = setup.db();
      await queuePush(db, approvalNote(await agentName(db, asked.owner, asked.agent), asked, setup.appUrl), setup.now());
    },
  };
}
