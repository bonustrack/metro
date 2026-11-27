export interface Send {
  ticket: string;
  text: string;
}

const waiting = new Map<string, Send>();

export function rememberSend(message: string, ticket: string, text: string): void {
  waiting.set(message, { ticket, text });
}

export function takeSend(message: string): Send | null {
  const send = waiting.get(message) ?? null;
  waiting.delete(message);
  return send;
}

const goOns = new Map<string, string[]>();

export function holdGoOn(message: string, text: string): void {
  const held = goOns.get(message) ?? [];
  if (!held.includes(text)) goOns.set(message, [...held, text]);
}

export function takeGoOns(message: string): string[] {
  const held = goOns.get(message) ?? [];
  goOns.delete(message);
  return held;
}
