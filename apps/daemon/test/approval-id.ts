const ID = /approval id "([a-km-z]{5})"/;

interface TextResult {
  content: { type?: string; text?: string }[];
}

export function approvalIdIn(text: string): string {
  const id = ID.exec(text)?.[1];
  if (id === undefined) throw new Error(`no approval id in: ${text}`);
  return id;
}

export const approvalIdOf = (result: TextResult | undefined): string =>
  approvalIdIn(result?.content.map((part) => part.text ?? '').join('\n') ?? '');
