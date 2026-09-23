import type { OutlookLogin } from '@metro-labs/outlook/login';
import { StationAttachError } from './attach.js';
import type { DriverHooks, StartedAttach, StepInput } from './attach-driver.js';

const BROWSER_PROMPT =
  'Sign in with Microsoft in a new tab, with the mailbox this agent should read. This page updates on its own once you are done.';
const DEVICE_PROMPT =
  'Open the Microsoft sign-in page, type this code, and sign in with the mailbox this agent should read.';
const OTHER_ATTEMPT = 'This sign-in link belongs to another attempt. Start again from the Channels page.';
const BROWSER_TTL_MS = 15 * 60_000;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function startOutlook(input: Record<string, unknown>, hooks: DriverHooks): Promise<StartedAttach> {
  const { OutlookBrowserLogin, OutlookLogin: DeviceLogin, OutlookLoginError, failureOf, parseMailbox } = await import('@metro-labs/outlook/login');
  const said = (err: unknown, fallback: string): string =>
    err instanceof OutlookLoginError && err.message !== '' ? err.message : fallback;
  const { browser, mailbox } = (() => {
    try {
      const wanted = parseMailbox(input.mailbox);
      return { browser: new OutlookBrowserLogin({ mailbox: wanted }), mailbox: wanted };
    } catch (err) {
      throw new StationAttachError(said(err, 'Microsoft refused to start the sign-in'), 400);
    }
  })();
  let device: OutlookLogin | null = null;

  const toDevice = async (): Promise<void> => {
    if (device !== null) return;
    const login = new DeviceLogin({ onDone: hooks.done, onFailed: hooks.fail }, { mailbox });
    const code = await login.start().catch((err: unknown) => {
      throw new StationAttachError(said(err, 'Microsoft refused to start the sign-in'), 400);
    });
    device = login;
    hooks.prompt({ step: 'device', prompt: DEVICE_PROMPT, userCode: code.userCode, verificationUri: code.verificationUri });
  };

  const finish = async (input: StepInput): Promise<void> => {
    const state = text(input.state);
    if (state !== browser.state) throw new StationAttachError(OTHER_ATTEMPT, 400);
    const error = text(input.error);
    if (error !== '') {
      hooks.fail(failureOf({ error, error_description: text(input.errorDescription) }));
      return;
    }
    const code = text(input.code);
    if (code === '') throw new StationAttachError('Microsoft did not send a sign-in code back', 400);
    try {
      hooks.done(await browser.finish(code, state));
    } catch (err) {
      hooks.fail(said(err, 'Metro could not finish the Microsoft sign-in.'));
    }
  };

  return {
    prompt: { step: 'browser', prompt: BROWSER_PROMPT, authorizeUrl: browser.authorizeUrl },
    expiresAt: Date.now() + BROWSER_TTL_MS,
    driver: {
      cancel: () => device?.cancel() ?? Promise.resolve(),
      submit: (input) => (input.mode === 'device' ? toDevice() : finish(input)),
    },
  };
}
