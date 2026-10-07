import { createHash } from 'node:crypto';
import { isRecord } from './is-record.js';

export const AUTOMATION_PROMPT_MAX = 64 * 1024;
const PROMPT_JSON_MAX = 128 * 1024 + 2;
export const AUTOMATION_REQUEST_MAX = 512;
export const AUTOMATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTOMATION_ROUTINE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = ['dispatched', 'consumed', 'awaiting-completion', 'completed', 'failed', 'interrupted', 'coalesced', 'cancelled'] as const;
const DETAILS = ['sdk-completed', 'sdk-failed', 'runner-interrupted', 'newer-slot', 'owner-cancelled', 'worker-blocked', 'worker-completed'] as const;
const TERMINAL = new Set<AutomationState>(['completed', 'coalesced', 'cancelled']);
const ERRORS = {
  'invalid-routine': 'Routine must be a lowercase name of at most 64 characters.',
  'invalid-slot': 'Slot must be an integer timestamp within the past seven days or next five minutes.',
  'invalid-prompt': 'Prompt must be text no larger than 64 KiB and 128 KiB plus quotes when JSON-encoded.',
  'invalid-uuid': 'Automation identifier must be a canonical UUID.',
  'invalid-request': 'Automation request is invalid.',
  'invalid-status': 'Automation status is invalid.',
  'invalid-resolution': 'Automation completion receipt is invalid.',
  conflict: 'This routine and slot already have a different prompt.',
  full: 'Automation queue is full. Only old terminal requests may be pruned.',
  'unknown-request': 'Automation request does not exist.',
  'invalid-token': 'Completion token does not match the dispatched request.',
  'unsafe-storage': 'Automation storage must be private, owned by this user, and free of symlinks.',
  'corrupt-storage': 'Automation storage is corrupt. No requests were discarded.',
  'storage-unavailable': 'Automation storage is unavailable. No acceptance is confirmed.',
} as const;

export type AutomationUuid = `${string}-${string}-${string}-${string}-${string}`;
export type AutomationState = (typeof STATES)[number];
export type AutomationDetail = (typeof DETAILS)[number];
export type AutomationOutcome = 'completed' | 'blocked';
export type AutomationErrorCode = keyof typeof ERRORS;

export class AutomationError extends Error {
  constructor(readonly code: AutomationErrorCode, options?: ErrorOptions) {
    super(ERRORS[code], options);
    this.name = 'AutomationError';
  }
}

export interface AutomationRequest {
  version: 1;
  routine: string;
  slot: number;
  uuid: AutomationUuid;
  createdAt: number;
  prompt: string;
  digest: string;
}

export interface AutomationStatus {
  uuid: AutomationUuid;
  state: AutomationState;
  updatedAt: number;
  token: AutomationUuid;
  detail?: AutomationDetail;
}

export interface AutomationResolution {
  uuid: AutomationUuid;
  token: AutomationUuid;
  outcome: AutomationOutcome;
  createdAt: number;
}

export function assertRoutine(routine: unknown): asserts routine is string {
  if (typeof routine !== 'string' || !AUTOMATION_ROUTINE_RE.test(routine)) throw new AutomationError('invalid-routine');
}

export function assertAutomationUuid(uuid: unknown): asserts uuid is AutomationUuid {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw new AutomationError('invalid-uuid');
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function promptValid(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= AUTOMATION_PROMPT_MAX && Buffer.byteLength(JSON.stringify(value), 'utf8') <= PROMPT_JSON_MAX;
}

function validSlot(slot: number, now: number): boolean {
  return slot >= now - AUTOMATION_RETENTION_MS && slot <= now + 300_000;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function requestUuid(routine: string, slot: number): AutomationUuid {
  const bytes = createHash('sha256').update(`${routine}\n${slot}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function automationRequest(routine: string, slot: number, prompt: string, now = Date.now()): AutomationRequest {
  assertRoutine(routine);
  if (!timestamp(now) || !timestamp(slot) || !validSlot(slot, now)) throw new AutomationError('invalid-slot');
  if (!promptValid(prompt)) throw new AutomationError('invalid-prompt');
  return { version: 1, routine, slot, uuid: requestUuid(routine, slot), createdAt: now, prompt, digest: hash(prompt) };
}

function fields(raw: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(raw, key)) && Object.keys(raw).every((key) => required.includes(key) || optional.includes(key));
}

export function parseAutomationRequest(raw: unknown): AutomationRequest {
  if (!isRecord(raw) || !fields(raw, ['version', 'routine', 'slot', 'uuid', 'createdAt', 'prompt', 'digest'])) throw new AutomationError('invalid-request');
  assertRoutine(raw.routine);
  assertAutomationUuid(raw.uuid);
  if (raw.version !== 1 || !timestamp(raw.slot) || !timestamp(raw.createdAt) || !promptValid(raw.prompt)) throw new AutomationError('invalid-request');
  if (!validSlot(raw.slot, raw.createdAt) || raw.uuid !== requestUuid(raw.routine, raw.slot) || raw.digest !== hash(raw.prompt)) throw new AutomationError('invalid-request');
  return { version: 1, routine: raw.routine, slot: raw.slot, uuid: raw.uuid, createdAt: raw.createdAt, prompt: raw.prompt, digest: raw.digest };
}

export function parseAutomationStatus(raw: unknown): AutomationStatus {
  if (!isRecord(raw) || !fields(raw, ['uuid', 'state', 'updatedAt', 'token'], ['detail'])) throw new AutomationError('invalid-status');
  assertAutomationUuid(raw.uuid);
  assertAutomationUuid(raw.token);
  const state = STATES.find((entry) => entry === raw.state);
  if (state === undefined || !timestamp(raw.updatedAt)) throw new AutomationError('invalid-status');
  const detail = DETAILS.find((entry) => entry === raw.detail);
  if (raw.detail !== undefined && detail === undefined) throw new AutomationError('invalid-status');
  return { uuid: raw.uuid, state, updatedAt: raw.updatedAt, token: raw.token, ...(detail === undefined ? {} : { detail }) };
}

export function parseAutomationResolution(raw: unknown): AutomationResolution {
  if (!isRecord(raw) || !fields(raw, ['uuid', 'token', 'outcome', 'createdAt'])) throw new AutomationError('invalid-resolution');
  assertAutomationUuid(raw.uuid);
  assertAutomationUuid(raw.token);
  if (!timestamp(raw.createdAt) || (raw.outcome !== 'completed' && raw.outcome !== 'blocked')) throw new AutomationError('invalid-resolution');
  return { uuid: raw.uuid, token: raw.token, outcome: raw.outcome, createdAt: raw.createdAt };
}

export function automationTerminal(state: AutomationState): boolean {
  return TERMINAL.has(state);
}
