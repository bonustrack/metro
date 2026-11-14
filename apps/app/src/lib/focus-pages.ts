import type { Selection } from '@metro-labs/client/selection';

const FOCUS_KINDS = new Set<Selection['kind']>(['add-chat', 'move-channel', 'org-model-add', 'org-model-sign-in', 'org-aws', 'org-connector-new', 'app-connect']);

export const isFocusPage = (selection: Selection): boolean => FOCUS_KINDS.has(selection.kind);
