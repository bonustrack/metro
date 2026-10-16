import type { ConnectionRow } from '@metro-labs/client/api/model';
import type { ModelOption } from '@metro-labs/client/api/model-options';
import { DEFAULT_MODEL } from '@metro-labs/client/api/providers';
import { useConnectionModelsQuery } from '../lib/model-queries.js';

export function nameIn(options: ModelOption[] | undefined, model: string): string {
  if (model === '') return DEFAULT_MODEL;
  const found = options?.find((option) => option.id === model);
  if (found === undefined || found.name === '') return model;
  const cut = found.name.indexOf(': ');
  return cut === -1 ? found.name : found.name.slice(cut + 2);
}

export function useModelName(conn: ConnectionRow | undefined, model: string): string {
  const models = useConnectionModelsQuery(conn);
  return conn === undefined ? DEFAULT_MODEL : nameIn(models.data, model);
}
