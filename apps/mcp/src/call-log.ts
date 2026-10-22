import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import type { AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import type { Database } from '@metro-labs/connectors/db/database';
import { CALL_NAME_MAX, recordCall } from '@metro-labs/connectors/db/mcp-calls';

const KEY_MAX = 128;
const OUTCOME_MAX = 32;
const MS_MAX = 2_147_483_647;
const UNDEFINED_TABLE = '42P01';
const DEPTH = 4;

export interface CallRecord {
  connector: string | null;
  connectorKey: string;
  connectorName: string | null;
  tool: string;
  outcome: string;
  ms: number;
  at: number;
}

export interface CallRecorder {
  record: (identity: AgentKeyRow, call: CallRecord) => void;
}

function missingTable(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < DEPTH && isRecord(current); i += 1) {
    if (current.code === UNDEFINED_TABLE) return true;
    current = current.cause;
  }
  return false;
}

const clampMs = (ms: number): number => Math.min(MS_MAX, Math.max(0, Math.round(ms)));

export function callRecorder(db: () => Database): CallRecorder {
  let quiet = false;
  const failed = (err: unknown): void => {
    if (quiet) return;
    quiet = true;
    if (missingTable(err)) log.warn('mcp: the mcp_calls table does not exist yet, so calls are not recorded until api.metro.box migrates');
    else log.warn({ err: errMsg(err) }, 'mcp: could not record a call, later failures stay quiet until one works');
  };
  const recorded = (): void => {
    if (!quiet) return;
    quiet = false;
    log.info('mcp: recording calls again');
  };
  return {
    record: (identity, call) => {
      const write = async (): Promise<void> => {
        await recordCall(db(), {
          id: newId(),
          owner: identity.owner,
          agent: identity.agent,
          connector: call.connector,
          connectorKey: call.connectorKey.slice(0, KEY_MAX),
          connectorName: call.connectorName?.slice(0, CALL_NAME_MAX) ?? null,
          tool: call.tool.slice(0, KEY_MAX),
          outcome: call.outcome.slice(0, OUTCOME_MAX),
          ms: clampMs(call.ms),
          at: call.at,
        });
        recorded();
      };
      write().catch(failed);
    },
  };
}
