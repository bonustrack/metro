import type { ConnectionRow, ModelSettings, Provider } from '@metro-labs/client/api/model';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import type { OrgModelPatch } from '@metro-labs/client/api/org-models';

export interface KeyDraft {
  label: string;
  key: string;
  region: string;
}

const OWN = 'This agent uses its own model order.';
const ORGANIZATION = 'This agent uses the organization’s default model order.';
const NONE = 'No model order is set yet, so this agent has no model.';

export function sourceLine(source: ModelSettings['source'], route: ModelRoute | null): string {
  if (source === 'agent') return OWN;
  return source === null && route === null ? NONE : ORGANIZATION;
}

export function withRoute(settings: ModelSettings, route: ModelRoute | null, choices: ConnectionRow[]): ModelSettings {
  const known = new Set(settings.connections.map((c) => c.id));
  return { ...settings, route, connections: [...settings.connections, ...choices.filter((c) => !known.has(c.id))] };
}

export function connectionPatch(provider: Provider, draft: KeyDraft, row: ConnectionRow | null): OrgModelPatch {
  const key = draft.key.trim() === '' ? {} : { apiKey: draft.key.trim() };
  const label = draft.label.trim() === '' || draft.label.trim() === row?.label ? {} : { label: draft.label.trim() };
  const region = provider === 'bedrock' && draft.region.trim() !== row?.region ? { region: draft.region.trim() } : {};
  return { ...key, ...label, ...region };
}
