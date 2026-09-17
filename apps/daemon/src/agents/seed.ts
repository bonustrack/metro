import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from './files.js';
import { LOCAL_PROJECT_ID, localCreateAgent, localOwner, storedAgents } from './file-admin.js';

export const SEED_FILE = '.agent';

export type Seeded = 'created' | 'present' | 'none' | 'failed';

export async function seedAgent(dir = agentsDir()): Promise<Seeded> {
  const path = join(dir, SEED_FILE);
  if (!existsSync(path)) return 'none';
  const name = readFileSync(path, 'utf8').trim();
  const owner = localOwner(dir);
  if (owner === null) {
    log.warn({ name }, 'agent seed: no owner yet, leaving the seed for the next boot');
    return 'failed';
  }
  if (storedAgents(dir).length > 0) {
    rmSync(path, { force: true });
    return 'present';
  }
  try {
    const made = await localCreateAgent(owner, LOCAL_PROJECT_ID, name, dir);
    rmSync(path, { force: true });
    log.info({ id: made.id, name: made.name }, 'agent seed: agent created from the launch name');
    return 'created';
  } catch (err) {
    log.warn({ name, err: errMsg(err) }, 'agent seed: could not create the agent');
    return 'failed';
  }
}
