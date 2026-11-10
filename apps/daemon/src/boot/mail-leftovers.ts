import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { isRetiredStation, RETIRED_STATIONS, type RetiredStation } from '@metro-labs/core/station-names';
import { agentFilePath, agentsDir } from '../agents/files.js';

export interface MailLeftoverDirs {
  agents?: string;
  trains: string;
}

interface Removed {
  accounts: number;
  files: number;
}

const STATE_DIRS: Record<RetiredStation, string> = { outlook: 'OUTLOOK_STATE_DIR', gmail: 'GMAIL_STATE_DIR' };
const TMP = '(?:\\.tmp-[0-9]+)?';

const metroDir = (): string => join(homedir(), '.metro');
const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);

function readAgent(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), path }, 'mail: could not read the agent file to drop the old mail channels');
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    log.warn({ path }, 'mail: the agent file is not JSON, so its old mail channels stay');
    return null;
  }
}

function dropAccounts(path: string): number {
  const agent = readAgent(path);
  if (agent === null || !Array.isArray(agent.stations)) return 0;
  const kept: unknown[] = agent.stations.filter((entry) => !isRecord(entry) || !isRetiredStation(entry.station));
  const dropped = agent.stations.length - kept.length;
  if (dropped > 0) writeSecure(path, `${JSON.stringify({ ...agent, stations: kept }, null, 2)}\n`);
  return dropped;
}

function namesIn(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir).filter((name) => pattern.test(name));
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), dir }, 'mail: could not list the files of the old mail channels');
    return [];
  }
}

function removeOne(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      log.warn({ path }, 'mail: left a file of the old mail channels alone, it is not a regular file');
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), path }, 'mail: could not remove a file of the old mail channels');
    return false;
  }
}

function accountsFile(station: RetiredStation): string {
  return process.env[`${station.toUpperCase()}_ACCOUNTS_FILE`] ?? join(metroDir(), `${station}-accounts.json`);
}

function stationFiles(station: RetiredStation, trains: string): string[] {
  const stateDir = process.env[STATE_DIRS[station]] ?? metroDir();
  const accounts = accountsFile(station);
  return [
    ...namesIn(stateDir, new RegExp(`^${station}-state-[A-Za-z0-9_-]+\\.json${TMP}$`)).map((name) => join(stateDir, name)),
    ...namesIn(dirname(accounts), new RegExp(`^${escaped(basename(accounts))}${TMP}$`)).map((name) => join(dirname(accounts), name)),
    ...namesIn(trains, new RegExp(`^${station}\\.ts$`)).map((name) => join(trains, name)),
  ];
}

function leftoverFiles(agents: string, trains: string): string[] {
  const host = namesIn(agents, new RegExp(`^\\.gmail-host${TMP}$`)).map((name) => join(agents, name));
  return [...new Set([...RETIRED_STATIONS.flatMap((station) => stationFiles(station, trains)), ...host])];
}

function attempt(what: string, run: () => number): number {
  try {
    return run();
  } catch (err) {
    log.warn({ err: errMsg(err) }, `mail: could not remove ${what} of the old Gmail and Outlook channels`);
    return 0;
  }
}

export function removeMailLeftovers(dirs: MailLeftoverDirs): Removed {
  const agents = dirs.agents ?? agentsDir();
  const accounts = attempt('the accounts', () => dropAccounts(agentFilePath(agents)));
  const files = attempt('the files', () => leftoverFiles(agents, dirs.trains).filter(removeOne).length);
  log.info({ accounts, files }, 'mail: removed the old Gmail and Outlook channels, which are connectors now');
  return { accounts, files };
}
