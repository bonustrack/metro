import { StationAttachError } from './attach.js';

export const INTERACTIVE_STATIONS = ['telegram-user', 'whatsapp'] as const;

export type InteractiveStation = (typeof INTERACTIVE_STATIONS)[number];

export type AttachStep = 'code' | 'password' | 'scan' | 'pair';

export interface AttachPrompt {
  step: AttachStep;
  prompt: string;
  qr?: string;
  pairingCode?: string;
}

export interface AttachOutcome {
  config: Record<string, unknown>;
  identity: Record<string, string>;
}

export interface DriverHooks {
  prompt: (p: AttachPrompt) => void;
  done: (o: AttachOutcome) => void;
  fail: (message: string) => void;
}

export interface AttachDriver {
  submit: (input: { code?: unknown; password?: unknown }) => Promise<void>;
  cancel: () => Promise<void>;
}

export interface StartedAttach {
  driver: AttachDriver;
  prompt: AttachPrompt;
}

const CODE_PROMPT =
  'Telegram sent a login code to that number. Enter it here.';
const PASSWORD_PROMPT =
  'This account has two-step verification. Enter its password.';
const SCAN_PROMPT =
  'Open WhatsApp on your phone, go to Settings, Linked Devices, Link a Device, and scan this code.';
const PAIR_PROMPT =
  'Open WhatsApp on your phone, go to Settings, Linked Devices, Link a Device, Link with phone number, and type this code.';

export function isInteractiveStation(raw: unknown): raw is InteractiveStation {
  return (
    typeof raw === 'string' &&
    (INTERACTIVE_STATIONS as readonly string[]).includes(raw)
  );
}

function refuse(err: unknown, fallback: string): never {
  throw new StationAttachError(
    err instanceof Error && err.message !== '' ? err.message : fallback,
    400,
  );
}

async function startTelegramUser(
  input: Record<string, unknown>,
  hooks: DriverHooks,
): Promise<StartedAttach> {
  const { TelegramUserLogin, TelegramUserLoginError, validateCredentials } =
    await import('@metro-labs/telegram-user/login');
  const isOwn = (e: unknown): boolean => e instanceof TelegramUserLoginError;
  let login;
  try {
    login = new TelegramUserLogin(
      validateCredentials({
        apiId: input.apiId,
        apiHash: input.apiHash,
        phone: input.phone,
      }),
    );
    await login.requestCode();
  } catch (err) {
    await login?.close();
    refuse(isOwn(err) ? err : null, 'Telegram refused to start the sign-in');
  }
  const settled = login;
  return {
    prompt: { step: 'code', prompt: CODE_PROMPT },
    driver: {
      cancel: () => settled.close(),
      submit: async (values) => {
        try {
          if (typeof values.password === 'string') {
            hooks.done(await settled.submitPassword(values.password));
            return;
          }
          if (typeof values.code !== 'string')
            throw new StationAttachError('enter the login code', 400);
          const result = await settled.submitCode(values.code);
          if (result === 'password') {
            hooks.prompt({ step: 'password', prompt: PASSWORD_PROMPT });
            return;
          }
          hooks.done(result);
        } catch (err) {
          if (err instanceof StationAttachError) throw err;
          refuse(isOwn(err) ? err : null, 'Telegram refused the sign-in');
        }
      },
    },
  };
}

async function startWhatsapp(
  input: Record<string, unknown>,
  hooks: DriverHooks,
): Promise<StartedAttach> {
  const { WhatsappLogin, WhatsappLoginError, normalizePhone } = await import(
    '@metro-labs/whatsapp/login'
  );
  const isOwn = (e: unknown): boolean => e instanceof WhatsappLoginError;
  let login;
  try {
    login = new WhatsappLogin(normalizePhone(input.phone), {
      onQr: (qr) => {
        hooks.prompt({ step: 'scan', prompt: SCAN_PROMPT, qr });
      },
      onPairingCode: (pairingCode) => {
        hooks.prompt({ step: 'pair', prompt: PAIR_PROMPT, pairingCode });
      },
      onPaired: hooks.done,
      onFailed: hooks.fail,
    });
    await login.start();
  } catch (err) {
    await login?.cancel();
    refuse(isOwn(err) ? err : null, 'WhatsApp refused to start the pairing');
  }
  const settled = login;
  const qrMode = settled.mode === 'qr';
  return {
    prompt: qrMode
      ? { step: 'scan', prompt: SCAN_PROMPT }
      : { step: 'pair', prompt: PAIR_PROMPT },
    driver: {
      cancel: () => settled.cancel(),
      submit: () =>
        Promise.reject(
          new StationAttachError(
            'this pairing finishes on your phone, there is nothing to submit here',
            409,
          ),
        ),
    },
  };
}

export async function startInteractiveAttach(
  station: InteractiveStation,
  input: Record<string, unknown>,
  hooks: DriverHooks,
): Promise<StartedAttach> {
  return station === 'telegram-user'
    ? startTelegramUser(input, hooks)
    : startWhatsapp(input, hooks);
}
