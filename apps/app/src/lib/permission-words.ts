import type { Access, ToolGroup } from '@metro-labs/client/api/policy';

export type PermissionGroup = 'read' | 'write' | 'delete';

export type PermissionChoice = 'allow' | 'ask' | 'block';

export type PermissionValue = PermissionChoice | 'mixed' | null;

export const PERMISSION_CHOICES: readonly PermissionChoice[] = ['allow', 'ask', 'block'];

export const CHOICE_WORD: Record<PermissionChoice, string> = { allow: 'Allow', ask: 'Ask', block: 'Block' };

export const GROUP_WORD: Record<PermissionGroup, string> = { read: 'Read', write: 'Write', delete: 'Delete' };

export const MIXED_WORD = 'Mixed';

const ACCESS_OF: Record<PermissionChoice, Access> = { allow: 'allow', ask: 'ask', block: 'deny' };

const CHOICE_OF: Record<Access, PermissionChoice> = { allow: 'allow', ask: 'ask', deny: 'block' };

export const accessOfChoice = (choice: PermissionChoice): Access => ACCESS_OF[choice];

export const choiceOfAccess = (access: Access): PermissionChoice => CHOICE_OF[access];

export function choiceOf(value: unknown): PermissionChoice | null {
  if (value === 'allow' || value === 'ask' || value === 'deny') return CHOICE_OF[value];
  return value === 'block' ? 'block' : null;
}

export const valueWord = (value: PermissionValue): string | null => (value === null ? null : value === 'mixed' ? MIXED_WORD : CHOICE_WORD[value]);

export function groupValue(choices: readonly PermissionChoice[]): PermissionValue {
  const first = choices[0];
  if (first === undefined) return null;
  return choices.every((choice) => choice === first) ? first : 'mixed';
}

const rank = (choice: PermissionChoice): number => PERMISSION_CHOICES.indexOf(choice);

export function strictest(choices: readonly PermissionChoice[]): PermissionChoice | null {
  return choices.reduce<PermissionChoice | null>((worst, choice) => (worst === null || rank(choice) > rank(worst) ? choice : worst), null);
}

export const looserThan = (choice: PermissionChoice, floor: PermissionChoice | null | undefined): boolean => floor !== null && floor !== undefined && rank(choice) < rank(floor);

export function permissionGroupOf(tool: { group: ToolGroup; destructive?: boolean }): PermissionGroup {
  if (tool.group === 'read') return 'read';
  return tool.destructive === true ? 'delete' : 'write';
}

export const apiGroupOf = (group: PermissionGroup): ToolGroup => (group === 'read' ? 'read' : 'write');

export interface ChoiceState {
  choice: PermissionChoice;
  word: string;
  selected: boolean;
  disabled: boolean;
}

export function choiceStates(value: PermissionValue, options: { disabled?: boolean; atLeast?: PermissionChoice | null } = {}): ChoiceState[] {
  return PERMISSION_CHOICES.map((choice) => ({
    choice,
    word: CHOICE_WORD[choice],
    selected: value === choice,
    disabled: options.disabled === true || looserThan(choice, options.atLeast),
  }));
}
