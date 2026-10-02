import type { IncomingMessage } from 'node:http';
import { log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { readJsonBody, type ApiSession } from '@metro-labs/http/api-http';
import {
  claudeSetupStatus,
  ensureClaudeSetup,
  isPermissionMode,
  liveEvents,
  permissionMode,
  setLiveEvents,
  setMemoryRoutine,
  setPermissionMode,
  setPrivacy,
  setSystemPrompt,
  systemPrompt,
  SYSTEM_PROMPT_MAX,
  type PermissionMode,
  type SetupDeps,
} from './setup.js';
import { harnessRunner, isHarnessRunner, sdkAllowed, sdkOnLogin, SDK_NEEDS_KEY, setHarnessRunner, setSdkOnLogin, settleRunner, type HarnessRunner } from './runner.js';
import { sessionRunning, stopSession, type SessionDeps } from './session.js';
import { tryMemoryJob } from './memory-routine.js';

const SETUP_BODY_MAX = SYSTEM_PROMPT_MAX * 2;
const OPERATOR_ONLY = 'only the Metro operator can allow the Agent SDK on a Claude login';

export interface SetupApiDeps {
  session?: SessionDeps;
  setup?: SetupDeps;
  liveEvents?: (on: boolean) => void;
  memoryJob?: (on: boolean) => void;
}

interface SetupChange {
  privacy?: boolean;
  permissionMode?: PermissionMode;
  runner?: HarnessRunner;
  sdkOnLogin?: boolean;
  systemPrompt?: string;
  liveEvents?: boolean;
  memoryRoutine?: boolean;
}

function promptChange(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ApiError('systemPrompt must be text', 400);
  if (Buffer.byteLength(raw) > SYSTEM_PROMPT_MAX) throw new ApiError(`systemPrompt must be under ${String(SYSTEM_PROMPT_MAX / 1024)} KiB`, 400);
  return raw;
}

function flagChange(raw: unknown, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw new ApiError(`${name} must be true or false`, 400);
  return raw;
}

function modeChange(raw: unknown): PermissionMode | undefined {
  if (raw === undefined) return undefined;
  if (!isPermissionMode(raw)) throw new ApiError('permissionMode must be auto or bypass', 400);
  return raw;
}

function runnerChange(raw: unknown): HarnessRunner | undefined {
  if (raw === undefined) return undefined;
  if (!isHarnessRunner(raw)) throw new ApiError('runner must be cli or sdk', 400);
  return raw;
}

function setupChange(body: unknown): SetupChange {
  if (!isRecord(body)) throw new ApiError('a body is required', 400);
  const change: SetupChange = {
    privacy: flagChange(body.privacy, 'privacy'),
    permissionMode: modeChange(body.permissionMode),
    runner: runnerChange(body.runner),
    sdkOnLogin: flagChange(body.sdkOnLogin, 'sdkOnLogin'),
    systemPrompt: promptChange(body.systemPrompt),
    liveEvents: flagChange(body.liveEvents, 'liveEvents'),
    memoryRoutine: flagChange(body.memoryRoutine, 'memoryRoutine'),
  };
  const given = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) as SetupChange;
  if (Object.keys(given).length === 0) throw new ApiError('nothing to change', 400);
  return given;
}

function checkRunnerChange(change: SetupChange, session: ApiSession, agents: string | undefined): void {
  if (change.sdkOnLogin !== undefined && session.operator !== true) throw new ApiError(OPERATOR_ONLY, 403);
  if (change.runner !== 'sdk' || harnessRunner(agents) === 'sdk') return;
  if (!sdkAllowed(agents) && change.sdkOnLogin !== true) throw new ApiError(SDK_NEEDS_KEY, 403);
}

function runnerRestarts(change: SetupChange, agents: string | undefined): boolean {
  let restart = false;
  if (change.sdkOnLogin !== undefined && change.sdkOnLogin !== sdkOnLogin(agents)) {
    setSdkOnLogin(change.sdkOnLogin, agents);
    log.info({ on: change.sdkOnLogin }, 'claude-setup: the operator changed whether the Agent SDK may run on this box’s Claude login');
    restart = settleRunner(agents);
  }
  if (change.runner !== undefined && change.runner !== harnessRunner(agents)) {
    setHarnessRunner(change.runner, agents);
    restart = true;
  }
  return restart;
}

function restartsSession(change: SetupChange, agents: string | undefined): boolean {
  let restart = runnerRestarts(change, agents);
  if (change.permissionMode !== undefined && change.permissionMode !== permissionMode(agents)) {
    setPermissionMode(change.permissionMode, agents);
    restart = true;
  }
  if (change.systemPrompt !== undefined && change.systemPrompt.trim() !== systemPrompt(agents)) {
    setSystemPrompt(change.systemPrompt, agents);
    restart = true;
  }
  return restart;
}

function applyLiveEvents(on: boolean, deps: SetupApiDeps): void {
  const agents = deps.setup?.agents;
  if (on !== liveEvents(agents)) setLiveEvents(on, agents);
  deps.liveEvents?.(on);
}

function applyMemoryRoutine(on: boolean, deps: SetupApiDeps): void {
  setMemoryRoutine(on, deps.setup?.agents);
  (deps.memoryJob ?? tryMemoryJob)(on);
}

function applySetupChange(change: SetupChange, session: ApiSession, deps: SetupApiDeps): void {
  const setup = deps.setup ?? {};
  checkRunnerChange(change, session, setup.agents);
  if (change.privacy !== undefined) setPrivacy(change.privacy, setup.agents);
  if (change.liveEvents !== undefined) applyLiveEvents(change.liveEvents, deps);
  if (change.memoryRoutine !== undefined) applyMemoryRoutine(change.memoryRoutine, deps);
  if (restartsSession(change, setup.agents) && sessionRunning(deps.session?.tmux ?? 'tmux')) stopSession(deps.session ?? {});
  ensureClaudeSetup(setup);
}

export async function setupAnswer(req: IncomingMessage, deps: SetupApiDeps, session: ApiSession): Promise<unknown> {
  const setup = deps.setup ?? {};
  const method = req.method ?? 'GET';
  if (method === 'GET') return claudeSetupStatus(setup);
  if (method !== 'POST') throw new ApiError('method not allowed', 405);
  applySetupChange(setupChange(await readJsonBody(req, SETUP_BODY_MAX)), session, deps);
  return claudeSetupStatus(setup);
}
