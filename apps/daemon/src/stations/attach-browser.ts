import { SignInError, parseMailbox } from '@metro-labs/core/stations/oauth';
import { StationAttachError } from './attach.js';
import type { AttachOutcome, DriverHooks, StartedAttach, StepInput } from './attach-driver.js';

const OUTLOOK_PROMPT =
  'Sign in with Microsoft in a new tab, with the mailbox this agent should read. This page updates on its own once you are done.';
const GMAIL_PROMPT =
  'Sign in with Google in a new tab, with the mailbox this agent should read. This page updates on its own once you are done.';
const DEVICE_PROMPT =
  'Open the Microsoft sign-in page, type this code, and sign in with the mailbox this agent should read.';
const OTHER_ATTEMPT = 'This sign-in link belongs to another attempt. Start again from the Channels page.';
const BROWSER_TTL_MS = 15 * 60_000;

interface BrowserLogin {
  state: string;
  authorizeUrl: string;
  finish: (code: string, state: string) => Promise<AttachOutcome>;
}

interface BrowserAttach {
  provider: string;
  prompt: string;
  failure: (body: Record<string, unknown>) => string;
  device?: () => Promise<void>;
  cancel?: () => Promise<void>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const said = (err: unknown, fallback: string): string => (err instanceof SignInError && err.message !== '' ? err.message : fallback);

function refused(err: unknown, provider: string): StationAttachError {
  return new StationAttachError(said(err, `${provider} refused to start the sign-in`), 400);
}

function browserAttach(login: BrowserLogin, hooks: DriverHooks, how: BrowserAttach): StartedAttach {
  const finish = async (input: StepInput): Promise<void> => {
    const state = text(input.state);
    if (state !== login.state) throw new StationAttachError(OTHER_ATTEMPT, 400);
    const error = text(input.error);
    if (error !== '') {
      hooks.fail(how.failure({ error, error_description: text(input.errorDescription) }));
      return;
    }
    const code = text(input.code);
    if (code === '') throw new StationAttachError(`${how.provider} did not send a sign-in code back`, 400);
    try {
      hooks.done(await login.finish(code, state));
    } catch (err) {
      hooks.fail(said(err, `Metro could not finish the ${how.provider} sign-in.`));
    }
  };
  const device = how.device;
  return {
    prompt: { step: 'browser', prompt: how.prompt, authorizeUrl: login.authorizeUrl },
    expiresAt: Date.now() + BROWSER_TTL_MS,
    driver: {
      cancel: () => how.cancel?.() ?? Promise.resolve(),
      submit: (input) => (input.mode === 'device' && device !== undefined ? device() : finish(input)),
    },
  };
}

export async function startOutlook(input: Record<string, unknown>, hooks: DriverHooks): Promise<StartedAttach> {
  const { OutlookBrowserLogin, OutlookLogin: DeviceLogin, failureOf } = await import('@metro-labs/outlook/login');
  const { browser, mailbox } = (() => {
    try {
      const wanted = parseMailbox(input.mailbox);
      return { browser: new OutlookBrowserLogin({ mailbox: wanted }), mailbox: wanted };
    } catch (err) {
      throw refused(err, 'Microsoft');
    }
  })();
  let device: InstanceType<typeof DeviceLogin> | null = null;
  const toDevice = async (): Promise<void> => {
    if (device !== null) return;
    const login = new DeviceLogin({ onDone: hooks.done, onFailed: hooks.fail }, { mailbox });
    const code = await login.start().catch((err: unknown) => {
      throw refused(err, 'Microsoft');
    });
    device = login;
    hooks.prompt({ step: 'device', prompt: DEVICE_PROMPT, userCode: code.userCode, verificationUri: code.verificationUri });
  };
  return browserAttach(browser, hooks, {
    provider: 'Microsoft',
    prompt: OUTLOOK_PROMPT,
    failure: (body) => failureOf(body),
    device: toDevice,
    cancel: () => device?.cancel() ?? Promise.resolve(),
  });
}

export async function startGmail(input: Record<string, unknown>, hooks: DriverHooks): Promise<StartedAttach> {
  const { GmailBrowserLogin, failureOf } = await import('@metro-labs/gmail/login');
  let login;
  try {
    login = new GmailBrowserLogin({ clientId: input.clientId, clientSecret: input.clientSecret, mailbox: input.mailbox });
  } catch (err) {
    throw refused(err, 'Google');
  }
  return browserAttach(login, hooks, { provider: 'Google', prompt: GMAIL_PROMPT, failure: failureOf });
}
