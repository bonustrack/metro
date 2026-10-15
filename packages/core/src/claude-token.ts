const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{32,512}$/;
const FOUND_RE = /sk-ant-oat01-[A-Za-z0-9_-]*/g;

export const isClaudeToken = (value: string): boolean => TOKEN_RE.test(value);

export function claudeTokenIn(text: string): string | null {
  const found = (text.match(FOUND_RE) ?? []).filter(isClaudeToken);
  return found.at(-1) ?? null;
}

export const withoutClaudeTokens = (text: string): string => text.replace(FOUND_RE, '[token]');
