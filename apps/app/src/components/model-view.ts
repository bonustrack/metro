import type { ConnectionRow, ModelSettings, Provider } from '@metro-labs/client/api/model';
import { routeSteps, type ModelRoute } from '@metro-labs/client/api/model-route';
import type { OrgModelConnection, OrgModelPatch, OrgModels } from '@metro-labs/client/api/org-models';
import { connectionDetail, providerLabel } from '@metro-labs/client/api/providers';

export interface KeyDraft {
  label: string;
  key: string;
  region: string;
}

const OWN = 'This agent uses its own model order.';
const ORGANIZATION = 'This agent uses the organization’s default model order.';
const NONE = 'No model order is set yet, so this agent has no model.';

export function routesUsing(list: OrgModels, id: string): number {
  const routes = [...(list.default === null ? [] : [list.default]), ...Object.values(list.agents)];
  return routes.filter((route) => routeSteps(route).some((step) => step.connection === id)).length;
}

export function orgConnectionDetail(list: OrgModels, connection: OrgModelConnection): string {
  const routes = routesUsing(list, connection.id);
  const use = routes === 0 ? 'not used yet' : `in ${String(routes)} model ${routes === 1 ? 'order' : 'orders'}`;
  return [providerLabel(connection.provider), connectionDetail(connection), use].join(' · ');
}

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
