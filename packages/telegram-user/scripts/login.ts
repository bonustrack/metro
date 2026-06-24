import { TelegramClient } from '@mtcute/bun';
import qrcode from 'qrcode-terminal';

const out = (s: string) => process.stdout.write(s);

const apiId = Number(process.env.TELEGRAM_USER_API_ID);
const apiHash = process.env.TELEGRAM_USER_API_HASH;

if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  process.stderr.write(
    'set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH (from my.telegram.org) before running\n',
  );
  process.exit(1);
}

const tg = new TelegramClient({
  apiId,
  apiHash,
  storage: ':memory:',
});

const usePhone = process.argv.includes('--phone');

const signInWithPhone = () =>
  tg.start({
    phone: () => tg.input('phone number (international format): '),
    code: () => tg.input('login code: '),
    password: () => tg.input('2FA password (blank if none): '),
  });

const signInWithQr = () =>
  tg.signInQr({
    onUrlUpdated: (url) => {
      out('\nscan this QR in Telegram → Settings → Devices → Link Desktop Device:\n\n');
      qrcode.generate(url, { small: true }, (qr) => out(`${qr}\n`));
      out(`or open this link on the logged-in device:\n  ${url}\n\n`);
    },
    onQrScanned: () => out('QR scanned, finalizing...\n'),
    password: () => tg.input('2FA password: '),
  });

const user = usePhone ? await signInWithPhone() : await signInWithQr();

const session = await tg.exportSession();

out(`\nsigned in as ${user.displayName} (id ${user.id})\n\n`);
out('session string (store as a Fly secret, never commit or log):\n\n');
out(`${session}\n\n`);
out('  fly secrets set TELEGRAM_USER_SESSION="<session>" -a metro\n\n');

await tg.destroy();
process.exit(0);
