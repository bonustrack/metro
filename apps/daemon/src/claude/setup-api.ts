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
import { harnessRunner, isHarnessRunner, sdkAllowed, sdkOnLogin, SDK_NEEDS_KEY, setHarnessRunner, setSdkOnLogin, type HarnessRunner } from './runner.js';
import { assertSdkDrained, assertSessionStopped, prepareSessionRunner, setAutostart, withSessionChange, type SessionDeps } from './session.js';
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
  if (change.runner === 'sdk' && !sdkAllowed(agents, undefined, change.sdkOnLogin ?? sdkOnLogin(agents))) throw new ApiError(SDK_NEEDS_KEY, 403);
}

function nextRunner(change: SetupChange, agents: string | undefined): HarnessRunner {
  const runner = change.runner ?? harnessRunner(agents);
  return runner === 'sdk' && change.sdkOnLogin === false && !sdkAllowed(agents, undefined, false) ? 'cli' : runner;
}

function changesSession(change: SetupChange, agents: string | undefined): boolean {
  return nextRunner(change, agents) !== harnessRunner(agents)
    || (change.permissionMode !== undefined && change.permissionMode !== permissionMode(agents))
    || (change.systemPrompt !== undefined && change.systemPrompt.trim() !== systemPrompt(agents));
}

function saveSessionSettings(change: SetupChange, runner: HarnessRunner, agents: string | undefined): void {
  if (change.sdkOnLogin !== undefined && change.sdkOnLogin !== sdkOnLogin(agents)) {
    setSdkOnLogin(change.sdkOnLogin, agents);
    log.info({ on: change.sdkOnLogin }, 'claude-setup: the operator changed whether the Agent SDK may run on this box’s Claude login');
  }
  if (runner !== harnessRunner(agents)) {
    setAutostart(false, agents);
    setHarnessRunner(runner, agents);
  }
  if (change.permissionMode !== undefined) setPermissionMode(change.permissionMode, agents);
  if (change.systemPrompt !== undefined) setSystemPrompt(change.systemPrompt, agents);
}

function checkStoppedChange(change: SetupChange, deps: SetupApiDeps): HarnessRunner {
  const agents = deps.setup?.agents;
  const session = { ...deps.session, agents: deps.session?.agents ?? agents };
  const runner = nextRunner(change, agents);
  if (changesSession(change, agents)) assertSessionStopped(session);
  if (runner !== harnessRunner(agents) && harnessRunner(agents) === 'sdk') assertSdkDrained(session);
  return runner;
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

async function applySetupChange(change: SetupChange, session: ApiSession, deps: SetupApiDeps, req: IncomingMessage): Promise<void> {
  const setup = deps.setup ?? {};
  checkRunnerChange(change, session, setup.agents);
  const runner = checkStoppedChange(change, deps);
  if (runner !== harnessRunner(setup.agents)) {
    await prepareSessionRunner(runner, deps.session);
    checkRunnerChange(change, session, setup.agents);
    if (checkStoppedChange(change, deps) !== runner) throw new ApiError('The model setup changed during preparation. Choose the runner again.', 409);
  }
  if (req.socket.destroyed) throw new ApiError('The request disconnected during preparation. The runner choice was not changed.', 409);
  if (change.privacy !== undefined) setPrivacy(change.privacy, setup.agents);
  if (change.liveEvents !== undefined) applyLiveEvents(change.liveEvents, deps);
  if (change.memoryRoutine !== undefined) applyMemoryRoutine(change.memoryRoutine, deps);
  saveSessionSettings(change, runner, setup.agents);
  ensureClaudeSetup(setup);
}

export async function setupAnswer(req: IncomingMessage, deps: SetupApiDeps, session: ApiSession): Promise<unknown> {
  const setup = deps.setup ?? {};
  const method = req.method ?? 'GET';
  if (method === 'GET') return claudeSetupStatus(setup);
  if (method !== 'POST') throw new ApiError('method not allowed', 405);
  const change = setupChange(await readJsonBody(req, SETUP_BODY_MAX));
  await withSessionChange(() => applySetupChange(change, session, deps, req));
  return claudeSetupStatus(setup);
}
