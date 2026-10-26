import { STATION_FORMS, type StationForm } from './attach.js';

export const GMAIL_MANAGED = 'gmail-managed';
const GMAIL_UPDATE = 'Update Metro on this box for keyless and read-only Gmail. This version may also request permission to send.';
const GMAIL_READ_ONLY = 'Google grants read-only access, so the agent cannot send. Metro Write permission starts blocked. Allow sending later in this channel’s settings.';
export const GMAIL_SENDING_CONSENT = 'Lets Metro send from this mailbox at Google. The agent still cannot send until you set Metro Write permission to Allow or Ask below.';

export type GmailMode = 'managed' | 'byo';

export function gmailForm(managed: boolean, mode: GmailMode): StationForm {
  const form = STATION_FORMS.gmail;
  if (form === undefined) throw new Error('The Gmail form is missing.');
  if (!managed) return { ...form, hint: `${form.hint} ${GMAIL_UPDATE}` };
  return {
    ...form,
    hint: mode === 'managed'
      ? `Sign in with Google, no client ID or secret needed. ${GMAIL_READ_ONLY}`
      : `Connect through your own Google OAuth client. ${GMAIL_READ_ONLY}`,
    links: mode === 'managed' ? [] : form.links,
    fields: mode === 'managed' ? form.fields.filter((field) => field.key === 'mailbox') : form.fields,
  };
}

export function gmailConnectFields(managed: boolean, mode: GmailMode, fields: Record<string, string>): Record<string, string> {
  const form = gmailForm(managed, mode);
  const input: Record<string, string> = { mode: managed ? mode : 'byo', sendEnabled: 'false' };
  for (const field of form.fields) {
    const value = fields[field.key]?.trim() ?? '';
    if (value !== '') input[field.key] = value;
  }
  return input;
}

export function gmailUpgradeFields(accountId: string): Record<string, string> {
  return { accountId, sendEnabled: 'true', mode: 'upgrade' };
}

export function gmailAccess(supported: boolean, sendEnabled: boolean | null | undefined): { title: string; note: string; upgrade: boolean } {
  if (!supported) return { title: 'Google authorization', note: GMAIL_UPDATE, upgrade: false };
  if (typeof sendEnabled !== 'boolean') return {
    title: 'Google authorization',
    note: 'This connection does not say what Google allows. Reconnect it to pick read-only.',
    upgrade: false,
  };
  return sendEnabled ? {
    title: 'Sending authorized',
    note: 'Google allows sending. Metro Write permission below decides if the agent may.',
    upgrade: false,
  } : {
    title: 'Read-only',
    note: 'Google access is read-only. Allow sending with Google first, then set Metro Write permission below.',
    upgrade: true,
  };
}
