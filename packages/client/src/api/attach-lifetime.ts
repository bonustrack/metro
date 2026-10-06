import { accountIdentity, checkAccountIdentity, type AccountIdentity } from '../auth/account.js';
import { startAttach, type AttachStarted } from './attach.js';
import { cancelAttachSession, type AttachSession } from './attach-session.js';
import { agentsUrl } from './client.js';
import { forgetAttachSignIn } from './sign-in-return.js';

export class AttachLifetime {
  private closed = false;
  private starting = false;
  private session: AttachSession | null = null;

  constructor(readonly agentId: string, readonly base = agentsUrl(), readonly identity: AccountIdentity | null = accountIdentity()) {}

  async start(station: string, fields: Record<string, string>): Promise<AttachStarted | null> {
    if (this.closed || this.starting) return null;
    this.starting = true;
    try {
      const started = await startAttach(this.agentId, station, fields, this.base, this.identity);
      if (started.kind === 'pending') {
        if (this.closed) await this.cancel(started.session);
        else this.session = started.session;
      }
      return this.closed ? null : started;
    } finally {
      this.starting = false;
    }
  }

  update(session: AttachSession): boolean {
    if (this.closed) return false;
    checkAccountIdentity(this.identity);
    if (this.session !== null && this.session.status !== 'pending') return false;
    this.session = session;
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.session !== null) await this.cancel(this.session);
  }

  private async cancel(session: AttachSession): Promise<void> {
    forgetAttachSignIn(this.base, this.agentId, session.attachId);
    if (session.status === 'pending') await cancelAttachSession(this.agentId, session.attachId, this.base, this.identity);
  }
}
