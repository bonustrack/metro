export const NEEDS_APPROVAL = (where: string, tool: string): string =>
  `Needs the owner's approval for ${where} (${tool}). Make this exact call from a background worker so Claude Code asks the owner in chat, and wait for the answer. An approval given only in the terminal does not count.`;
