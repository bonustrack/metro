import { approvalFields } from '@metro-labs/core/approval-fields';
import type { ApprovalPart, ApprovalState, ChatPart } from '@metro-labs/core/chat';
import type { Chat, ChatPerson } from '@metro-labs/client/api/chats';
import { isRecord } from '@metro-labs/client/read';

const SUMMARY_MAX = 120;
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt', 'tool', 'text'];

export const toolLabel = (name: string): string => name.replace(/^mcp__metro__/, '').replace(/^mcp__/, '');

export function parsedInput(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function toolSummary(input: string): string {
  const value = parsedInput(input);
  if (value === null) return '';
  const key = SUMMARY_KEYS.find((k) => typeof value[k] === 'string' && value[k] !== '');
  const text = key === undefined ? '' : String(value[key]);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

export function prettyInput(input: string): string {
  const value = parsedInput(input);
  return value === null ? input : JSON.stringify(value, null, 2);
}

export interface CallField {
  label: string;
  value: string;
}

export function callFields(input: string): CallField[] {
  const value = parsedInput(input);
  if (value === null) return input.trim() === '' ? [] : [{ label: 'input', value: input }];
  return approvalFields(value).map(({ key, text }) => ({ label: key, value: text }));
}

export function sharedWords(chat: Pick<Chat, 'shared' | 'members' | 'createdBy'>, me: string): string {
  if (chat.shared === 'organization') return 'Everyone in the organization';
  const others = new Set([chat.createdBy, ...chat.members].filter((id) => id !== '' && id !== me)).size;
  if (others === 0) return 'Only you';
  return others === 1 ? 'You and 1 person' : `You and ${String(others)} people`;
}

export const isShared = (chat: Pick<Chat, 'shared' | 'members'>): boolean => chat.shared === 'organization' || chat.members.length > 0;

export const personOf = (people: readonly ChatPerson[], id: string | null): ChatPerson | undefined => (id === null ? undefined : people.find((p) => p.id === id));

export function clockOf(at: number, now = Date.now()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (when.toDateString() === new Date(now).toDateString()) return time;
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export function tookWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ${String(seconds % 60)} s`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

export const replyText = (parts: readonly ChatPart[]): string =>
  parts.flatMap((part) => (part.type === 'text' && part.text.trim() !== '' ? [part.text.trim()] : [])).join('\n\n');

export function greetingOf(now: Date, name: string | null): string {
  const hour = now.getHours();
  const part = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = name?.trim().split(/\s+/)[0] ?? '';
  return first === '' ? part : `${part}, ${first}`;
}

const WEB_ADDRESS = /^https?:\/\/\S+$/i;

export function imageLink(src: string, alt: string): { text: string; href: string | null } {
  const href = WEB_ADDRESS.test(src.trim()) ? src.trim() : null;
  const label = alt.replace(/\s+/g, ' ').trim();
  return { text: label === '' ? (href ?? 'An image') : label, href };
}

export function decidedWords(allow: boolean, goOnFailure: string | null): string {
  if (!allow) return 'Denied.';
  return goOnFailure === null ? 'Approved.' : `Approved. The message asking the agent to go on was not sent (${goOnFailure}), so tell it to go on.`;
}

export interface SentAnswer {
  state: ApprovalState;
  allow: boolean;
}

const APPROVAL_WORDS = { allowed: 'Approved.', denied: 'Denied.' } as const;

export function approvalAnswer(part: Pick<ApprovalPart, 'state'>, live: boolean, settled: boolean, sent: SentAnswer | null): { buttons: boolean; words: string } {
  if (sent !== null && sent.state === part.state) return { buttons: false, words: sent.allow ? 'Approved.' : 'Denied.' };
  if (part.state !== 'waiting') return { buttons: false, words: APPROVAL_WORDS[part.state] };
  if (live) return { buttons: true, words: '' };
  return { buttons: false, words: settled ? 'No answer was given.' : 'Waiting for an answer.' };
}
