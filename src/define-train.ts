import { serializeTrainError } from './train-error.js';
import type { WireEvent } from './history-types.js';

export {
  TrainError,
  serializeTrainError,
  type TrainErrorInfo,
} from './train-error.js';
export type { WireEvent } from './history-types.js';

export type Envelope = {
  kind?: 'inbound' | 'outbound';
  id?: string;
  ts?: string;
  station?: string;
  line: string;
  line_name?: string;
  from?: string;
  from_name?: string;
  to?: string;
  message_id?: string;
  reply_to?: string;
  is_private?: boolean;
  text?: string;
  emoji?: string;
  payload?: unknown;
  account?: string;
  event?: WireEvent;
} & Record<string, unknown>;

export interface CallMsg {
  op: 'call';
  id: string;
  action: string;
  args: Record<string, unknown>;
}

export interface AccountHandle<Client> {
  id: string;
  client: Client;
}

export interface TrainContext<Client> {
  readonly name: string;
  readonly selfUri: string;
  readonly accounts: ReadonlyMap<string, AccountHandle<Client>>;
  mintId(): string;
  emit(env: Partial<Envelope> & { line: string }): string;
  emitInbound(env: Partial<Envelope> & { line: string }): string;
  emitOutbound(
    env: Partial<Envelope> & { line: string; message_id: string },
  ): string;
  log(text: string): void;
}

export type ActionHandler<Client> = (
  args: Record<string, unknown>,
  ctx: TrainContext<Client>,
) => unknown;

export interface DefineTrainOptions<Client> {
  name?: string;
  accounts?: (
    ctx: TrainContext<Client>,
  ) => Promise<AccountHandle<Client>[]> | AccountHandle<Client>[];
  parseLine?: (line: string) => unknown;
  onInbound?: (ctx: TrainContext<Client>) => Promise<void> | void;
  actions: Record<string, ActionHandler<Client>>;
}

export interface RunningTrain<Client> {
  ctx: TrainContext<Client>;
  feedLine(line: string): void;
  stop(): void;
}

function mintIdImpl(): string {
  return `msg_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildTrain<Client>(
  opts: DefineTrainOptions<Client>,
  write: (s: string) => void = (s) => void process.stdout.write(s),
): {
  ctx: TrainContext<Client>;
  dispatch: (msg: CallMsg) => Promise<void>;
  boot: () => Promise<void>;
} {
  const name = opts.name ?? process.env.METRO_TRAIN_NAME ?? 'train';
  const selfUri = process.env.METRO_SELF_URI ?? '';
  const accounts = new Map<string, AccountHandle<Client>>();

  const emit = (env: Partial<Envelope> & { line: string }): string => {
    const id = typeof env.id === 'string' ? env.id : mintIdImpl();
    const { id: _ignored, ts, station, ...rest } = env;
    void _ignored;
    write(
      JSON.stringify({
        ...rest,
        id,
        ts: ts ?? new Date().toISOString(),
        station: station ?? name,
      }) + '\n',
    );
    return id;
  };

  const ctx: TrainContext<Client> = {
    name,
    selfUri,
    accounts,
    mintId: mintIdImpl,
    emit,
    emitInbound: (env) => emit({ kind: 'inbound', from: selfUri, ...env }),
    emitOutbound: (env) =>
      emit({ kind: 'outbound', from: selfUri, to: env.line, ...env }),
    log: (text) => {
      write(JSON.stringify({ op: 'log', text }) + '\n');
    },
  };

  const respond = (
    id: string,
    body: { result?: unknown; error?: string; errorInfo?: unknown },
  ): void => {
    write(JSON.stringify({ op: 'response', id, ...body }) + '\n');
  };

  const dispatch = async (msg: CallMsg): Promise<void> => {
    const handler = opts.actions[msg.action];
    if (!handler) {
      respond(msg.id, {
        error: `unknown action '${msg.action}' (have: ${Object.keys(opts.actions).join(', ')})`,
      });
      return;
    }
    try {
      const result = await handler(msg.args ?? {}, ctx);
      respond(msg.id, { result: result ?? null });
    } catch (err) {
      respond(msg.id, serializeTrainError(err));
    }
  };

  const boot = async (): Promise<void> => {
    if (opts.accounts) {
      for (const a of await opts.accounts(ctx)) accounts.set(a.id, a);
    }
  };

  return { ctx, dispatch, boot };
}

export async function defineTrain<Client = unknown>(
  opts: DefineTrainOptions<Client>,
): Promise<RunningTrain<Client>> {
  const { ctx, dispatch, boot } = buildTrain(opts);

  await boot();

  let buf = '';
  const onData = (chunk: string): void => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) feedLine(line);
    }
  };
  const feedLine = (line: string): void => {
    try {
      const msg: unknown = JSON.parse(line);
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { op?: unknown }).op === 'call'
      ) {
        void dispatch(msg as CallMsg);
      }
    } catch (err) {
      process.stderr.write(
        `${ctx.name}: bad stdin line: ${(err as Error).message}\n`,
      );
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);

  process.stderr.write(
    `${ctx.name} train ready (${ctx.accounts.size} account(s))\n`,
  );

  if (opts.onInbound) {
    void Promise.resolve(opts.onInbound(ctx)).catch((err: unknown) =>
      process.stderr.write(
        `${ctx.name}: inbound loop crashed: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
  }

  return {
    ctx,
    feedLine,
    stop: () => process.stdin.off('data', onData),
  };
}
