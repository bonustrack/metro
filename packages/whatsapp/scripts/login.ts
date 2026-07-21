import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import makeWASocket, {
  Browsers,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

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

const stateDir =
  process.env.METRO_STATE_DIR ?? join(homedir(), '.cache', 'metro');
const dir = join(stateDir, 'whatsapp', accountId);
mkdirSync(dir, { recursive: true });

const { state, saveCreds } = await useMultiFileAuthState(dir);

const sock = makeWASocket({
  auth: state,
  browser: Browsers.appropriate('Metro'),
  markOnlineOnConnect: false,
  syncFullHistory: false,
});

sock.ev.on('creds.update', () => void saveCreds());

let pairingRequested = false;

sock.ev.on('connection.update', (update) => {
  const { connection, qr } = update;
  if (qr && useQr) {
    out('\nscan this QR in WhatsApp → Settings → Linked Devices → Link a Device:\n\n');
    qrcode.generate(qr, { small: true }, (art) => out(`${art}\n`));
  }
  if (qr && !useQr && !pairingRequested && !state.creds.registered) {
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
  if (connection === 'open') {
    out(`\nlogged in — auth state saved to ${dir}\n`);
    out('on Fly this dir lives on the /data volume and persists across deploys.\n\n');
    setTimeout(() => process.exit(0), 1000);
  }
});
