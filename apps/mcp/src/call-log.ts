import { newId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { isNotMigrated } from '@metro-labs/connectors/db/errors';
import { CALL_NAME_MAX, recordCall, type CallKind } from '@metro-labs/connectors/db/mcp-calls';

const KEY_MAX = 128;
const OUTCOME_MAX = 32;
const MS_MAX = 2_147_483_647;

interface CallRecord {
  connector: string | null;
  connectorKey: string;
  connectorName: string | null;
  tool: string;
  outcome: string;
  ms: number;
  at: number;
  kind?: CallKind;
}

interface CallAgent {
  owner: string;
  agent: string;
}

export interface CallRecorder {
  record: (identity: CallAgent, call: CallRecord) => void;
}

const clampMs = (ms: number): number => Math.min(MS_MAX, Math.max(0, Math.round(ms)));

export function callRecorder(db: () => Database): CallRecorder {
  let quiet = false;
  const failed = (err: unknown): void => {
    if (quiet) return;
    quiet = true;
    if (isNotMigrated(err)) log.warn('mcp: the mcp_calls table is not migrated yet, so calls are not recorded until api.metro.box migrates');
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
          ...(call.kind === undefined ? {} : { kind: call.kind }),
        });
        recorded();
      };
      write().catch(failed);
    },
  };
}
