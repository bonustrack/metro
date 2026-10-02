import { TrainError } from '@metro-labs/core/train-error';

export interface GroupLike {
  id: string;
  appData?: string;
  updateAppData?: (s: string) => Promise<void>;
  updateName?: (s: string) => Promise<void>;
  updateDescription?: (s: string) => Promise<void>;
  removeMembers?: (inboxIds: string[]) => Promise<void>;
  sync?: () => Promise<unknown>;
}

const MAX_LABELS = 16;
const MAX_LABEL_LEN = 24;
const MAX_APP_DATA_BYTES = 8192;

function cleanLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LEN);
}

function cleanLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const label = cleanLabel(item);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

export function readAppDataObject(
  existingAppData: string | undefined,
): Record<string, unknown> {
  if (!existingAppData?.trim()) return {};
  const parsed: unknown = JSON.parse(existingAppData);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TrainError('INVALID_ARGS', 'Channel appData must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function normalizeAssigned(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TrainError('INVALID_ARGS', 'assigned must be an array of Ethereum addresses');
  }
  const addresses: string[] = [];
  for (const address of value) {
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
      throw new TrainError('INVALID_ARGS', 'assigned must contain valid Ethereum addresses');
    }
    addresses.push(address.trim().toLowerCase());
  }
  return [...new Set(addresses)];
}

export function metadataPatch(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TrainError('INVALID_ARGS', 'metadata must be a JSON object');
  }
  const patch = value as Record<string, unknown>;
  if (Object.hasOwn(patch, 'v')) {
    throw new TrainError('INVALID_ARGS', 'metadata cannot change the reserved v field');
  }
  return patch;
}

function trimmedString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function cleanCategory(v: unknown): string | undefined {
  return typeof v === 'string' ? cleanLabel(v) || undefined : undefined;
}

export function readAppData(appData: string | undefined): {
  labels: string[];
  category?: string;
  github?: string;
  preview?: string;
} {
  if (!appData?.trim()) return { labels: [] };
  try {
    const p: unknown = JSON.parse(appData);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { labels: [] };
    const rec = p as Record<string, unknown>;
    return {
      labels: cleanLabels(rec.labels),
      category: cleanCategory(rec.category),
      github: trimmedString(rec.github),
      preview: trimmedString(rec.preview),
    };
  } catch {
    return { labels: [] };
  }
}

function checkedLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((label: unknown) => typeof label !== 'string')) {
    throw new TrainError('INVALID_ARGS', 'labels must be an array of strings');
  }
  return cleanLabels(value);
}

function checkedCategory(value: unknown): string | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new TrainError('INVALID_ARGS', 'category must be a string or null');
  }
  return cleanCategory(value);
}

const KNOWN_FIELDS = new Map<string, (value: unknown) => unknown>([
  ['labels', checkedLabels],
  ['assigned', normalizeAssigned],
  ['github', (value) => normalizeGithubUrl(value) || undefined],
  ['preview', (value) => normalizePreviewUrl(value) || undefined],
  ['category', checkedCategory],
]);

function applyMergeKey(
  merged: Record<string, unknown>,
  k: string,
  v: unknown,
): void {
  const normalize = KNOWN_FIELDS.get(k);
  const value = normalize ? normalize(v) : v;
  if (value === undefined || value === null) Reflect.deleteProperty(merged, k);
  else Object.defineProperty(merged, k, { value, enumerable: true, configurable: true, writable: true });
}

export function mergeAppData(
  existingAppData: string | undefined,
  patch: Record<string, unknown>,
): { blob: string; merged: Record<string, unknown> } {
  const current = readAppDataObject(existingAppData);
  const checked = metadataPatch(patch);
  if (Object.hasOwn(checked, 'assigned') && Object.hasOwn(current, 'assigned')) {
    normalizeAssigned(current.assigned);
  }
  const merged: Record<string, unknown> = { v: 1, ...current };
  for (const [k, v] of Object.entries(checked)) applyMergeKey(merged, k, v);
  const blob = JSON.stringify(merged);
  if (Buffer.byteLength(blob, 'utf8') > MAX_APP_DATA_BYTES) {
    throw new TrainError('INVALID_ARGS', `Channel appData exceeds ${MAX_APP_DATA_BYTES} bytes`);
  }
  return { blob, merged };
}

export function normalizeGithubUrl(url: unknown): string {
  if (typeof url !== 'string')
    throw new Error('setGithub requires a `url` string');
  const trimmed = url.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid url: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`github url must be http(s): ${trimmed}`);
  }
  if (
    parsed.hostname !== 'github.com' &&
    parsed.hostname !== 'www.github.com'
  ) {
    throw new Error(`url must be a github.com URL: ${trimmed}`);
  }
  return trimmed;
}

export function normalizePreviewUrl(url: unknown): string {
  if (typeof url !== 'string')
    throw new Error('setPreview requires a `preview` string');
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`invalid preview url: ${trimmed}`);
  }
  return trimmed;
}
