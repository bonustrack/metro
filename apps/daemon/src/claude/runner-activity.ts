import { join } from 'node:path';
import { parseRunnerActivity, type RunnerActivity } from '@metro-labs/core/runner-activity';
import { readRange } from '../agent-user/agent-fs.js';

const MAX_BYTES = 65_536;

export function readAgentActivity(home: string): RunnerActivity | null {
  try {
    const path = join(home, '.metro', 'agent-status.json');
    const bytes = readRange(path, 0, MAX_BYTES + 1);
    if (bytes.length > MAX_BYTES) return null;
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    return parseRunnerActivity(raw);
  } catch {
    return null;
  }
}
