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

export function cleanLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const label = item.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LEN);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

export function labelsBlob(
  existingAppData: string | undefined,
  labels: string[],
  github?: string,
): string {
  let existing: Record<string, unknown> = {};
  if (existingAppData?.trim()) {
    try {
      const p: unknown = JSON.parse(existingAppData);
      if (p && typeof p === 'object' && !Array.isArray(p))
        existing = p as Record<string, unknown>;
    } catch {
      /* tolerate malformed */
    }
  }
  const blob: Record<string, unknown> = {
    ...existing,
    v: 1,
    labels: cleanLabels(labels),
  };
  if (typeof github === 'string') {
    if (github.trim()) blob.github = github.trim();
    else delete blob.github;
  }
  return JSON.stringify(blob);
}

export function readAppData(appData: string | undefined): {
  labels: string[];
  github?: string;
  preview?: string;
} {
  if (!appData?.trim()) return { labels: [] };
  try {
    const p: unknown = JSON.parse(appData);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { labels: [] };
    const rec = p as Record<string, unknown>;
    const github =
      typeof rec.github === 'string' && rec.github.trim()
        ? rec.github.trim()
        : undefined;
    const preview =
      typeof rec.preview === 'string' && rec.preview.trim()
        ? rec.preview.trim()
        : undefined;
    return { labels: cleanLabels(rec.labels), github, preview };
  } catch {
    return { labels: [] };
  }
}

export function mergeAppData(
  existingAppData: string | undefined,
  patch: Record<string, unknown>,
): { blob: string; merged: Record<string, unknown> } {
  let existing: Record<string, unknown> = {};
  if (existingAppData?.trim()) {
    try {
      const p: unknown = JSON.parse(existingAppData);
      if (p && typeof p === 'object' && !Array.isArray(p))
        existing = p as Record<string, unknown>;
    } catch {
      /* tolerate malformed */
    }
  }
  const merged: Record<string, unknown> = { ...existing, v: 1 };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'labels') {
      merged.labels = cleanLabels(v);
      continue;
    }
    if (k === 'github') {
      const g = normalizeGithubUrl(v);
      if (g) merged.github = g;
      else delete merged.github;
      continue;
    }
    if (k === 'preview') {
      const p = normalizePreviewUrl(v);
      if (p) merged.preview = p;
      else delete merged.preview;
      continue;
    }
    if (v === undefined || v === null) Reflect.deleteProperty(merged, k);
    else merged[k] = v;
  }
  return { blob: JSON.stringify(merged), merged };
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
