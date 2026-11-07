import type { ToolResult } from '@metro-labs/core/stations/types';

const ID = /approval id "([a-km-z]{5})"/;

export function approvalIdOf(result: ToolResult | undefined): string {
  const text = result?.content.map((part) => part.text).join('\n') ?? '';
  const id = ID.exec(text)?.[1];
  if (id === undefined) throw new Error(`no approval id in: ${text}`);
  return id;
}
