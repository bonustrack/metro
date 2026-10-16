import type { Approval } from './approvals.js';
import { isRecord } from '../read.js';
import { sizeLabel } from './when.js';

export interface CardField {
  label: string;
  value: string;
}

export interface CardFile {
  name: string;
  size: string | null;
}

export interface ApprovalCard {
  station: string | null;
  account: string | null;
  connector: string | null;
  title: string;
  ask: string;
  fields: CardField[];
  body: string | null;
  file: CardFile | null;
  moreFiles: number;
}

interface Target {
  station: string;
  account: string | null;
  resource: string;
}

const EMAIL = new Set(['outlook', 'gmail']);
const PLUGIN_TOOL = /^mcp__plugin_metro_(.+?)__(.+)$/;
const SERVER_TOOL = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.([^.\s]+)$/;
const PLACE = new Set(['line', 'account', 'station', 'text', 'subject', 'attachments']);
const BODY_MAX = 600;
const VALUE_MAX = 120;
const FIELDS_MAX = 4;
const SUBJECT_MAX = 255;

const TITLES: Record<string, string> = {
  react: 'React to a message',
  unreact: 'Remove a reaction',
  edit: 'Edit a message',
  delete: 'Delete a message',
  typing: 'Show that it is typing',
  read: 'Read messages',
  create_group: 'Create a group',
  add_members: 'Add people to a group',
  remove_members: 'Remove people from a group',
  set_profile: 'Change its profile',
  get_profile: 'Look up a profile',
  list_members: 'List the members',
  list_accounts: 'List its chats',
  list_channels: 'List the chats',
  create_upload: 'Prepare a file to send',
  export_invite: 'Share an invite link',
  close_channel: 'Close a channel',
  set_channel_metadata: 'Change a channel',
  group_info: 'Read the group details',
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const shorten = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max).trimEnd()}…` : value);

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function lineTarget(line: string): Target | null {
  if (!line.startsWith('metro://')) return null;
  const [station = '', account = '', ...rest] = line.slice('metro://'.length).split('/');
  if (station === '') return null;
  return { station, account: account === '' ? null : decode(account), resource: decode(rest.join('/')) };
}

function targetOf(input: Record<string, unknown> | null): Target | null {
  const fromLine = lineTarget(text(input?.line));
  if (fromLine !== null) return fromLine;
  const station = text(input?.station);
  if (station === '') return null;
  const account = text(input?.account);
  return { station, account: account === '' ? null : account, resource: '' };
}

const humanize = (name: string): string => {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words === '' ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const lowerFirst = (title: string): string => `${title.charAt(0).toLowerCase()}${title.slice(1)}`;

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function argFields(input: Record<string, unknown> | null): CardField[] {
  return Object.entries(input ?? {}).flatMap(([key, value]) => {
    const shown = PLACE.has(key) ? null : scalar(value);
    return shown === null ? [] : [{ label: humanize(key), value: shorten(shown, VALUE_MAX) }];
  }).slice(0, FIELDS_MAX);
}

const baseName = (path: string): string => path.split(/[/\\]/).filter((part) => part !== '').pop() ?? '';

function fileOf(raw: unknown, bytes: number | null): CardFile {
  const size = bytes === null ? null : sizeLabel(bytes);
  if (!isRecord(raw)) return { name: 'A file', size };
  const name = text(raw.name) || baseName(text(raw.path)) || baseName(text(raw.url).split('?')[0] ?? '') || 'A file';
  return { name, size };
}

function filesOf(input: Record<string, unknown> | null, bytes: (number | null)[]): Pick<ApprovalCard, 'file' | 'moreFiles'> {
  const list = Array.isArray(input?.attachments) ? input.attachments : [];
  return { file: list.length === 0 ? null : fileOf(list[0], bytes[0] ?? null), moreFiles: Math.max(0, list.length - 1) };
}

function metroTitle(tool: string, target: Target | null): string {
  const email = target !== null && EMAIL.has(target.station);
  const address = email && target.resource.includes('@');
  if (tool === 'send') return email ? (address ? 'Send an email' : 'Reply to an email') : 'Send a message';
  if (tool === 'reply') return email ? 'Reply to an email' : 'Reply to a message';
  return TITLES[tool] ?? humanize(tool);
}

function emailFields(tool: string, target: Target | null, input: Record<string, unknown> | null): CardField[] {
  if (tool !== 'send' || target === null || !EMAIL.has(target.station) || !target.resource.includes('@')) return [];
  const said = text(input?.text);
  const subject = text(input?.subject).trim() || (said.split('\n')[0] ?? '').trim().slice(0, SUBJECT_MAX);
  return [{ label: 'To', value: target.resource }, ...(subject === '' ? [] : [{ label: 'Subject', value: subject }])];
}

function bodyOf(tool: string, input: Record<string, unknown> | null): string | null {
  const said = tool === 'react' || tool === 'unreact' ? text(input?.emoji) : text(input?.text);
  const flat = said.replace(/\s+/g, ' ').trim();
  return flat === '' ? null : shorten(flat, BODY_MAX);
}

function metroCard(approval: Approval, input: Record<string, unknown> | null): ApprovalCard {
  const target = targetOf(input);
  const title = metroTitle(approval.tool, target);
  const email = emailFields(approval.tool, target, input);
  const messaging = ['send', 'reply', 'react', 'unreact', 'edit', 'delete', 'typing'].includes(approval.tool);
  return {
    station: target?.station ?? null,
    account: target?.account ?? null,
    connector: null,
    title,
    ask: lowerFirst(title),
    fields: email.length > 0 || messaging ? email : argFields(input),
    body: bodyOf(approval.tool, input),
    ...filesOf(input, approval.fileBytes),
  };
}

function connectorCard(connector: string, tool: string, input: Record<string, unknown> | null, bytes: (number | null)[]): ApprovalCard {
  const title = humanize(tool);
  return {
    station: null,
    account: null,
    connector,
    title,
    ask: `use ${title} on ${connector}`,
    fields: argFields(input),
    body: bodyOf('', input),
    ...filesOf(input, bytes),
  };
}

function otherCard(approval: Approval): ApprovalCard {
  const fields = argFields(approval.input);
  return {
    station: null,
    account: null,
    connector: null,
    title: approval.name,
    ask: `approve ${approval.name}`,
    fields,
    body: fields.length > 0 || approval.preview === '' ? bodyOf('', approval.input) : shorten(approval.preview, BODY_MAX),
    file: null,
    moreFiles: 0,
  };
}

export function approvalCard(approval: Approval): ApprovalCard {
  if (approval.tool !== approval.name) return metroCard(approval, approval.input);
  const plugin = PLUGIN_TOOL.exec(approval.name) ?? SERVER_TOOL.exec(approval.name);
  if (plugin?.[1] !== undefined && plugin[2] !== undefined) return connectorCard(plugin[1], plugin[2], approval.input, approval.fileBytes);
  return otherCard(approval);
}
