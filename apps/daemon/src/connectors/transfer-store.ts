import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@metro-labs/core/is-record';
import { newId, parseId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { connectorAuth, connectorName, readConfig } from './config.js';
import { parseConnectorUrl } from './url.js';
import { normalizePolicy } from '../policy/policy.js';
import { localImportConnectors, readLocalConnectors, type LocalConnectorRow } from './store.js';

export interface ConnectorCopyResult {
  sourceId: string | null;
  id?: string;
  status: 'copied' | 'skipped' | 'invalid';
}

function copyRow(raw: unknown): LocalConnectorRow {
  if (!isRecord(raw) || typeof raw.id !== 'string' || parseId(raw.id) === null || !isRecord(raw.config)) throw new ApiError('invalid connector', 400);
  const name = connectorName(raw.name);
  const url = parseConnectorUrl(raw.url).toString();
  if (raw.config.policy !== undefined) normalizePolicy(raw.config.policy);
  const config = readConfig(raw.config);
  if (!isDeepStrictEqual(config, raw.config)) throw new ApiError('invalid connector settings', 400);
  if (config.auth.kind === 'header') connectorAuth(config.auth.name, config.auth.value);
  return { id: raw.id, name, url, config };
}

export function copyConnectorRows(value: unknown, dir?: string): ConnectorCopyResult[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.connectors) || value.connectors.length > 500)
    throw new ApiError('invalid connector transfer', 400);
  const names = new Set(readLocalConnectors(dir).map((row) => row.name));
  const imported: LocalConnectorRow[] = [];
  const results: ConnectorCopyResult[] = value.connectors.map((raw: unknown) => {
    const sourceId = isRecord(raw) && typeof raw.id === 'string' ? parseId(raw.id) : null;
    let row: LocalConnectorRow;
    try {
      row = copyRow(raw);
    } catch {
      return { sourceId, status: 'invalid' };
    }
    if (names.has(row.name)) return { sourceId, status: 'skipped' };
    names.add(row.name);
    const id = newId();
    imported.push({ ...row, id });
    return { sourceId, id, status: 'copied' };
  });
  if (imported.length > 0) localImportConnectors(imported.map((row) => ({ ...row, config: { ...row.config } })), dir, 'append');
  return results;
}
