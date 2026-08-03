import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import { inMemoryAuthState } from './auth-state.js';

export class WhatsappLoginError extends Error {}

export interface WhatsappLoginEvents {
  onQr: (qr: string) => void;
  onPairingCode: (code: string) => void;
  onPaired: (result: {
    config: { phone: string; credentials: unknown };
    identity: { phone: string };
  }) => void;
  onFailed: (message: string) => void;
}

const PHONE_RE = /^[0-9]{6,15}$/;
const RESTART_REQUIRED = 515;

export function normalizePhone(raw: unknown): string {
  const phone = typeof raw === 'string' ? raw.replace(/[^0-9]/g, '') : '';
  if (phone !== '' && !PHONE_RE.test(phone))
    throw new WhatsappLoginError(
      'phone must be an international number in digits, for example 447700900123',
    );
  return phone;
}

function closeReason(err: unknown): number | undefined {
  return (err as { output?: { statusCode?: number } } | undefined)?.output
    ?.statusCode;
}

export class WhatsappLogin {
  private auth = inMemoryAuthState();
  private sock: WASocket | null = null;
  private pairingRequested = false;
  private settled = false;

  constructor(
    private phone: string,
    private events: WhatsappLoginEvents,
  ) {}

  get mode(): 'pairing-code' | 'qr' {
    return this.phone === '' ? 'qr' : 'pairing-code';
  }

  async start(): Promise<void> {
    const { version, error } = await fetchLatestWaWebVersion({});
    if (error)
      throw new WhatsappLoginError(
        'could not reach WhatsApp to start the pairing',
      );
    this.open(version);
  }

  private open(version: [number, number, number]): void {
    if (this.settled) return;
    const sock = makeWASocket({
      version,
      auth: this.auth.state,
      browser: Browsers.macOS('Safari'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false,
    });
    this.sock = sock;
    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (typeof qr === 'string') this.onQr(sock, qr);
      if (connection === 'open') this.finish();
      if (connection === 'close')
        this.onClose(version, closeReason(lastDisconnect?.error));
    });
  }

  private onQr(sock: WASocket, qr: string): void {
    if (this.settled) return;
    if (this.mode === 'qr') {
      this.events.onQr(qr);
      return;
    }
    if (this.pairingRequested || this.auth.state.creds.registered) return;
    this.pairingRequested = true;
    void sock
      .requestPairingCode(this.phone)
      .then((code) => {
        if (!this.settled) this.events.onPairingCode(code);
      })
      .catch(() => {
        this.fail('WhatsApp refused to issue a pairing code for that number');
      });
  }

  private onClose(
    version: [number, number, number],
    statusCode: number | undefined,
  ): void {
    if (this.settled) return;
    if (statusCode === DisconnectReason.loggedOut) {
      this.fail('WhatsApp ended the pairing, start again');
      return;
    }
    if (statusCode === RESTART_REQUIRED || statusCode === undefined) {
      this.open(version);
      return;
    }
    this.open(version);
  }

  private finish(): void {
    if (this.settled) return;
    const phone = this.auth.state.creds.me?.id.split(':')[0] ?? this.phone;
    const credentials = this.auth.serialize();
    this.settled = true;
    void this.closeSocket().then(() => {
      this.events.onPaired({
        config: { phone, credentials },
        identity: { phone },
      });
    });
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    void this.closeSocket().then(() => {
      this.events.onFailed(message);
    });
  }

  private closeSocket(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return Promise.resolve();
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.end(undefined);
    } catch {
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  async cancel(): Promise<void> {
    this.settled = true;
    await this.closeSocket();
  }
}
