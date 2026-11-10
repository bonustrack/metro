import { isRecord } from './is-record.js';

export interface ApprovalField {
  key: string;
  text: string;
}

const FIRST = [
  'text', 'attachments', 'wallet', 'frame', 'speech', 'subject', 'reply_to', 'account', 'members', 'addresses', 'inboxIds', 'removeInboxIds', 'removeSelf',
  'message_id', 'emoji', 'name', 'bio', 'avatar', 'question', 'questions', 'options', 'query', 'from',
];
const PLAIN_NAME = /^[a-z]\w*$/;

export const oneLine = (text: string): string => text.replace(/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ');

const plain = (value: unknown): value is string | number | boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const empty = (value: unknown): boolean => value === null || value === undefined || value === '' || (typeof value === 'object' && Object.keys(value).length === 0);

function valueText(value: unknown): string {
  if (plain(value)) return String(value);
  if (Array.isArray(value) && value.every(plain)) return value.join(', ');
  return JSON.stringify(value);
}

const fileText = (file: unknown): string => valueText(isRecord(file) && 'data' in file ? { ...file, data: 'inline data' } : file);

function fieldsOf(key: string, value: unknown): ApprovalField[] {
  if (empty(value)) return [];
  if (key === 'attachments' && Array.isArray(value))
    return value.map((file, at) => ({ key: `file ${String(at + 1)} of ${String(value.length)}`, text: oneLine(fileText(file)) }));
  return [{ key: oneLine(PLAIN_NAME.test(key) ? key : JSON.stringify(key)), text: oneLine(valueText(value)) }];
}

export function approvalFields(args: Record<string, unknown>): ApprovalField[] {
  const keys = [...FIRST.filter((key) => Object.hasOwn(args, key)), ...Object.keys(args).filter((key) => !FIRST.includes(key))];
  return keys.flatMap((key) => fieldsOf(key, args[key]));
}
