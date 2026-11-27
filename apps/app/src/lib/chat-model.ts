import type { ConnectionRow, ModelSettings } from '@metro-labs/client/api/model';
import type { ModelOption } from '@metro-labs/client/api/model-options';
import { modelOrder } from '@metro-labs/client/api/model-order';
import { DEFAULT_MODEL } from '@metro-labs/client/api/providers';
import { nameIn } from '../components/AgentModel.js';

export interface MainModel {
  connection: ConnectionRow | undefined;
  model: string;
}

export function mainModelOf(settings: ModelSettings): MainModel | null {
  const lead = modelOrder(settings)[0];
  return lead === undefined ? null : { connection: lead.connection, model: lead.model };
}

export interface ModelRead {
  settings: ModelSettings | undefined;
  failed: boolean;
  options: ModelOption[] | undefined;
  optionsSettled: boolean;
}

export type ChatModelView = { kind: 'pending' } | { kind: 'none' } | { kind: 'shown'; label: string };

export function chatModelView(read: ModelRead): ChatModelView {
  if (read.failed) return { kind: 'none' };
  if (read.settings === undefined) return { kind: 'pending' };
  const main = mainModelOf(read.settings);
  if (main === null) return { kind: 'none' };
  if (main.connection === undefined) return { kind: 'shown', label: DEFAULT_MODEL };
  return read.optionsSettled ? { kind: 'shown', label: nameIn(read.options, main.model) } : { kind: 'pending' };
}
