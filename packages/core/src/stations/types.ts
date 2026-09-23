import type { ProfileField } from './profile.js';

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
  data?: string;
  upload?: string;
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

export interface MetroMember {
  id: string;
  name?: string;
  display_name?: string;
  address?: string;
  roles?: string[];
  is_admin?: boolean;
  is_bot?: boolean;
}

export interface MemberCapability {
  supported: boolean;
  complete: boolean;
  reason?: string;
  total?: number;
}

export interface MemberList {
  members: MetroMember[];
  capability: MemberCapability;
}

export type GroupOp =
  | 'create_group'
  | 'add_members'
  | 'remove_members'
  | 'invite_link';

export type MemberOutcomeStatus = 'added' | 'invited' | 'removed' | 'failed';

export interface MemberOutcome {
  id: string;
  status: MemberOutcomeStatus;
  reason?: string;
}

export interface GroupCapability {
  supported: boolean;
  reason?: string;
}

export interface GroupResult {
  capability: GroupCapability;
  line?: string;
  id?: string;
  name?: string;
  members?: MemberOutcome[];
  inviteLink?: string;
}

export type ReadFilter = 'account' | 'query' | 'from' | 'until' | 'unread_only' | 'message_id';

export type AttachmentMode = 'canonical' | 'native' | 'none';

export interface Station {
  name: string;
  hasAccounts: boolean;
  hasTrain: boolean;
  messageVerbs: ReadonlySet<Verb>;
  groupOps?: ReadonlySet<GroupOp>;
  resolvesSenders?: boolean;
  profileFields?: ReadonlySet<ProfileField>;
  claimsName?: boolean;
  readsProfiles?: boolean;
  readFilters?: ReadonlySet<ReadFilter>;
  approvals?: boolean;
  attachmentMode: AttachmentMode;
  forget?: (accountId: string) => void;
  forgetExcept?: (keptAccountIds: readonly string[]) => void;
  sendAttachments?(
    line: string,
    atts: CanonicalAttachment[],
    ctx: ToolContext,
  ): Promise<string[]>;
  tools: StationTool[];
}
