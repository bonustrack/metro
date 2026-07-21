import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import { errMsg } from '@metro-labs/mcp/log';
import qrcode from 'qrcode-terminal';
import { usePostgresAuthState } from '../src/auth-state.js';

const out = (s: string): void => void process.stdout.write(s);

const accountId = process.env.WHATSAPP_ACCOUNT ?? 'w0';
const phone = (process.env.WHATSAPP_PHONE ?? '').replace(/[^0-9]/g, '');
const useQr = process.argv.includes('--qr');

if (!useQr && !phone) {
  process.stderr.write(
    'set WHATSAPP_PHONE (E.164 digits, e.g. 447700900123) for pairing-code login, or pass --qr\n',
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL?.trim()) {
  process.stderr.write(
    'DATABASE_URL is not set — WhatsApp auth state is stored in Postgres\n',
  );
  process.exit(1);
}

const { state, saveCreds } = await usePostgresAuthState(accountId);

const { version, error } = await fetchLatestWaWebVersion({});
if (error) {
  process.stderr.write(
    `failed to fetch WhatsApp web version: ${errMsg(error)}\n`,
  );
  process.exit(1);
}

let pairingRequested = false;

function requestPairing(sock: WASocket): void {
  pairingRequested = true;
  void sock
    .requestPairingCode(phone)
    .then((code) => {
      out(`\npairing code for +${phone}: ${code}\n`);
      out(
        'enter it in WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number\n\n',
      );
    })
    .catch((e: unknown) => {
      process.stderr.write(`requestPairingCode failed: ${String(e)}\n`);
      process.exit(1);
    });
}

function showQr(qr: string): void {
  out('\nscan this QR in WhatsApp → Settings → Linked Devices → Link a Device:\n\n');
  qrcode.generate(qr, { small: true }, (art) => out(`${art}\n`));
}

function start(): void {
  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Safari'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', () => void saveCreds());
  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr && useQr) showQr(qr);
    if (qr && !useQr && !pairingRequested && !state.creds.registered) {
      requestPairing(sock);
    }
    if (connection === 'open') {
      out(`\nlogged in — auth state saved to Postgres for account '${accountId}'\n`);
      out('the pairing lives in the DB and survives deploys and volume loss.\n\n');
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    if (connection === 'close') {
      const code = (
        lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        process.stderr.write(
          'logged out — clear the whatsapp_auth rows for this account and re-pair\n',
        );
        process.exit(1);
      }
      start();
    }
  });
}

start();
