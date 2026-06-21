export type Verb =
  | 'send'
  | 'reply'
  | 'react'
  | 'unreact'
  | 'edit'
  | 'delete'
  | 'read';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface CanonicalAttachment {
  path?: string;
  url?: string;
  mime?: string;
  name?: string;
}

export interface ToolContext {
  call(
    action: string,
    args: Record<string, unknown>,
  ): Promise<{ result: unknown }>;
  ok(text: string): ToolResult;
  okJson(value: unknown): ToolResult;
  err(text: string): ToolResult;
  readFile(path: string): Promise<Buffer>;
}

export interface StationTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type AttachmentMode = 'canonical' | 'native' | 'none';

export interface Station {
  name: string;
  hasAccounts: boolean;
  messageVerbs: ReadonlySet<Verb>;
  attachmentMode: AttachmentMode;
  sendAttachments?(
    line: string,
    atts: CanonicalAttachment[],
    ctx: ToolContext,
  ): Promise<string[]>;
  parseLine(line: string): { accountId: string; resource: string } | null;
  mutates: ReadonlySet<string>;
  tools: StationTool[];
}
