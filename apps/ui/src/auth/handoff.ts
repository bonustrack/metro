const HANDOFF_RE = /^#\/auth\/([A-Za-z0-9_-]{16,128})$/;

export const handoffCode = (hash: string): string | null => HANDOFF_RE.exec(hash)?.[1] ?? null;
