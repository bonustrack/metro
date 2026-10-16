import type { Selection } from '@metro-labs/client/selection';

const FOCUS_KINDS = new Set<Selection['kind']>(['add-chat', 'org-model-add', 'org-model-sign-in', 'org-aws']);

export const isFocusPage = (selection: Selection): boolean => FOCUS_KINDS.has(selection.kind);
