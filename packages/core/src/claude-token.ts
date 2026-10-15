const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{32,512}$/;

export const isClaudeToken = (value: string): boolean => TOKEN_RE.test(value);
