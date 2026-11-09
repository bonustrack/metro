import type { MetroEvent } from '@metro-labs/core/events';
import { errMsg, log } from '@metro-labs/core/log';
import type { MailOutcome, MailTaken, McpMail } from '@metro-labs/http/mcp-server-protocol';
import { agentNameOf, knownAgentIds } from '../agents/map.js';
import { connectorMailEvent } from '../channels/connector-mail.js';

export type TakeMail = (mail: McpMail) => MailOutcome | null;

const TAKEN_MAX = 2_000;

export class MailIntake {
  private readonly taken = new Map<string, MailOutcome>();

  constructor(private readonly take: TakeMail) {}

  receive(mails: McpMail[]): MailTaken[] {
    const out: MailTaken[] = [];
    for (const mail of mails) {
      const outcome = this.taken.get(mail.id) ?? this.tryTake(mail);
      if (outcome === null) continue;
      this.remember(mail.id, outcome);
      out.push({ id: mail.id, outcome });
    }
    return out;
  }

  private tryTake(mail: McpMail): MailOutcome | null {
    try {
      return this.take(mail);
    } catch (err) {
      log.warn({ inbox: mail.id, err: errMsg(err) }, 'mcp-server: a connector mail could not be delivered; it comes again');
      return null;
    }
  }

  private remember(id: string, outcome: MailOutcome): void {
    this.taken.delete(id);
    this.taken.set(id, outcome);
    for (const oldest of this.taken.keys()) {
      if (this.taken.size <= TAKEN_MAX) break;
      this.taken.delete(oldest);
    }
  }
}

export function connectorMailTaker(publish: (event: MetroEvent) => void, live: () => boolean): TakeMail {
  return (mail) => {
    const agentId = knownAgentIds()[0];
    if (agentId === undefined) return null;
    if (!live()) {
      log.info({ inbox: mail.id, connector: mail.connector }, 'mcp-server: messages are paused, so a connector mail is dropped');
      return 'paused';
    }
    publish(connectorMailEvent(mail, agentId, agentNameOf(agentId)));
    log.info({ inbox: mail.id, connector: mail.connector }, 'mcp-server: a connector mail reached the agent');
    return 'delivered';
  };
}
