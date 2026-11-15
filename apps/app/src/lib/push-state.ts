export type PushPermission = 'granted' | 'denied' | 'undetermined';

export type PushState = 'unsupported' | 'off' | 'on' | 'blocked' | 'unavailable';

export interface PermissionAnswer {
  status: PushPermission;
  canAskAgain: boolean;
}

export interface PushNative {
  permission: () => Promise<PermissionAnswer>;
  request: () => Promise<PermissionAnswer>;
  prepare: () => Promise<void>;
  token: () => Promise<string>;
}

export interface PushServer {
  register: (token: string) => Promise<void>;
  unregister: (token: string) => Promise<void>;
}

export interface PushStore {
  read: (key: string) => string | null;
  write: (key: string, value: string | null) => void;
}

export interface PushContext {
  native: PushNative | null;
  server: PushServer;
  store: PushStore;
}

export const PUSH_KEYS = { asked: 'metro.push.asked', off: 'metro.push.off', token: 'metro.push.token' } as const;
export const FORGET_WAIT_MS = 5000;

const settledWithin = (work: Promise<unknown>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });

function blockedOr(answer: PermissionAnswer, otherwise: PushState): PushState {
  return answer.status === 'denied' && !answer.canAskAgain ? 'blocked' : otherwise;
}

async function register(ctx: PushContext, native: PushNative): Promise<PushState> {
  await native.prepare();
  let token: string;
  try {
    token = await native.token();
  } catch {
    return 'unavailable';
  }
  const before = ctx.store.read(PUSH_KEYS.token);
  await ctx.server.register(token);
  ctx.store.write(PUSH_KEYS.token, token);
  if (before !== null && before !== token) await ctx.server.unregister(before).catch(() => undefined);
  return 'on';
}

export async function readPushState(ctx: PushContext): Promise<PushState> {
  if (ctx.native === null) return 'unsupported';
  if (ctx.store.read(PUSH_KEYS.off) !== null) return 'off';
  const answer = await ctx.native.permission();
  if (answer.status === 'granted') return ctx.store.read(PUSH_KEYS.token) === null ? 'off' : 'on';
  return blockedOr(answer, 'off');
}

export async function startPush(ctx: PushContext): Promise<PushState> {
  const native = ctx.native;
  if (native === null) return 'unsupported';
  if (ctx.store.read(PUSH_KEYS.off) !== null) return 'off';
  let answer = await native.permission();
  if (answer.status === 'undetermined' && ctx.store.read(PUSH_KEYS.asked) === null) {
    ctx.store.write(PUSH_KEYS.asked, '1');
    answer = await native.request();
  }
  if (answer.status !== 'granted') return blockedOr(answer, 'off');
  return register(ctx, native);
}

export async function turnPushOn(ctx: PushContext): Promise<PushState> {
  const native = ctx.native;
  if (native === null) return 'unsupported';
  ctx.store.write(PUSH_KEYS.off, null);
  ctx.store.write(PUSH_KEYS.asked, '1');
  let answer = await native.permission();
  if (answer.status !== 'granted' && answer.canAskAgain) answer = await native.request();
  if (answer.status !== 'granted') return blockedOr(answer, 'off');
  return register(ctx, native);
}

export async function turnPushOff(ctx: PushContext): Promise<PushState> {
  if (ctx.native === null) return 'unsupported';
  ctx.store.write(PUSH_KEYS.off, '1');
  const token = ctx.store.read(PUSH_KEYS.token);
  if (token !== null) {
    await ctx.server.unregister(token);
    ctx.store.write(PUSH_KEYS.token, null);
  }
  return 'off';
}

export async function forgetPushDevice(ctx: PushContext, waitMs = FORGET_WAIT_MS): Promise<void> {
  const token = ctx.store.read(PUSH_KEYS.token);
  if (token === null) return;
  ctx.store.write(PUSH_KEYS.token, null);
  await settledWithin(ctx.server.unregister(token), waitMs);
}

export async function pushTokenMoved(ctx: PushContext): Promise<PushState> {
  const native = ctx.native;
  if (native === null) return 'unsupported';
  if (ctx.store.read(PUSH_KEYS.off) !== null || ctx.store.read(PUSH_KEYS.token) === null) return readPushState(ctx);
  return register(ctx, native);
}
