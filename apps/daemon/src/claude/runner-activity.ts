import { join } from 'node:path';
import { parseRunnerActivity, type RunnerActivity } from '@metro-labs/core/runner-activity';
import { readRange, statSync } from '../agent-user/agent-fs.js';

const MAX_BYTES = 65_536;

export function readAgentActivity(home: string): RunnerActivity | null {
  try {
    const path = join(home, '.metro', 'agent-status.json');
    const size = statSync(path).size;
    if (size > MAX_BYTES) return null;
    const raw: unknown = JSON.parse(readRange(path, 0, MAX_BYTES).toString('utf8'));
    return parseRunnerActivity(raw);
  } catch {
    return null;
  }
}
