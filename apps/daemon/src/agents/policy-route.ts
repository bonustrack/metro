import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { bodyField, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import type { StationName } from '@metro-labs/core/station-names';
import { normalizePolicy, type ToolPolicy } from '../policy/policy.js';

export type SetPolicy = (agentId: string, station: StationName, accountId: string, policy: ToolPolicy) => Promise<ToolPolicy>;

export async function handlePolicy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { setPolicy: SetPolicy; reloadAgents: () => Promise<void> },
  agentId: string,
  target: { station: StationName; accountId: string },
): Promise<void> {
  const wanted = normalizePolicy(bodyField(await readJsonBody(req), 'policy'));
  const policy = await deps.setPolicy(agentId, target.station, target.accountId, wanted);
  log.info({ agentId, station: target.station, account: target.accountId, policy }, 'account-api: tool policy set');
  const activated = await deps.reloadAgents().then(
    () => true,
    (err: unknown) => {
      log.warn({ err: errMsg(err) }, 'account-api: policy reload failed, the change lands at the next boot');
      return false;
    },
  );
  sendJson(req, res, 200, { agentId, station: target.station, accountId: target.accountId, policy, activated });
}
