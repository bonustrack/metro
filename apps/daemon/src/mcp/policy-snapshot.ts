import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { errMsg, log } from '@metro-labs/core/log';
import type { ToolGroup } from '@metro-labs/core/stations/types';
import { agentsDir } from '../agents/files.js';
import { knownAccounts } from '../agents/map.js';
import { onPoliciesChanged, storedPolicies, type ToolPolicy } from '../policy/policy.js';
import { UNGATED } from './policy-gate.js';
import { connectorGates } from '../connectors/gates.js';
import { stationToolOwners, TOOL_DEFS, toolGroupOf } from './tool-catalog.js';

interface PolicySnapshot {
  version: 1;
  tools: Record<string, ToolGroup>;
  owners: Record<string, string>;
  ungated: string[];
  accounts: Record<string, ToolPolicy>;
  stations: Record<string, string[]>;
  connectors: Record<string, SnapshotConnector>;
}

interface SnapshotConnector {
  id: string;
  name: string;
  policy: ToolPolicy;
  tools: Record<string, ToolGroup>;
}

const FILE = 'policy.json';

export const policySnapshotPath = (dir = agentsDir()): string => join(dir, FILE);

function policySnapshot(): PolicySnapshot {
  const accounts: Record<string, ToolPolicy> = {};
  for (const { target, policy } of storedPolicies())
    if (target.kind === 'channel') accounts[`${target.station}/${target.account}`] = policy;
  const stations: Record<string, string[]> = {};
  for (const known of knownAccounts()) (stations[known.station] ??= []).push(known.id);
  return {
    version: 1,
    tools: Object.fromEntries(TOOL_DEFS.map((def) => [def.name, toolGroupOf(def.name)])),
    owners: stationToolOwners(),
    ungated: [...UNGATED],
    accounts,
    stations,
    connectors: Object.fromEntries(
      connectorGates()
        .filter((gate) => gate.server !== '')
        .map((gate) => [gate.server, { id: gate.id, name: gate.name, policy: gate.policy, tools: gate.tools }]),
    ),
  };
}

function current(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function writePolicySnapshot(path = policySnapshotPath()): void {
  const text = `${JSON.stringify(policySnapshot(), null, 2)}\n`;
  if (current(path) === text) return;
  try {
    writeSecure(path, text);
    log.info({ path }, 'policy: snapshot for the plugin hook written');
  } catch (err) {
    log.warn({ path, err: errMsg(err) }, 'policy: the snapshot for the plugin hook could not be written');
  }
}

export function watchPolicySnapshot(): () => void {
  writePolicySnapshot();
  return onPoliciesChanged(() => {
    writePolicySnapshot();
  });
}
