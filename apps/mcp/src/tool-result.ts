export interface ToolResult {
  content: Record<string, unknown>[];
  isError?: true;
}

export const textBlock = (text: string): Record<string, unknown> => ({ type: 'text', text });

export const errorResult = (text: string): ToolResult => ({ content: [textBlock(text)], isError: true });
