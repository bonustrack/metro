import { accountForCall, convOf, lineOf } from './accounts.js';
import { respond } from './wire.js';
import { warmGroupName } from './conv-name.js';
import { mergeAppData, readAppData, type GroupLike } from './labels.js';
import { TrainError } from '../../train-error.js';

type Args = Record<string, unknown>;

export function resolveLine(args: Args, verb: string): string {
  const line = (args as { line?: string }).line;
  if (line) return line;
  const groupId = (args as { groupId?: string }).groupId;
  if (groupId) {
    const acct = accountForCall(args);
    return lineOf(acct.cfg.id, groupId);
  }
  throw new TrainError(
    'INVALID_ARGS',
    `${verb} requires \`line\` or \`groupId\``,
  );
}

export async function applyChannelMeta(
  args: {
    line: string;
    name?: string;
    description?: string;
    appData?: Record<string, unknown>;
  },
  verb: string,
): Promise<Record<string, unknown>> {
  const { line, name, description, appData } = args;
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  const group = conv as unknown as GroupLike;
  if (typeof group.updateAppData !== 'function') {
    throw new TrainError(
      'INVALID_ARGS',
      `${verb} target is not a group (no updateAppData)`,
    );
  }
  await group.sync?.().catch(() => undefined);

  if (
    typeof name === 'string' &&
    name &&
    typeof group.updateName === 'function'
  ) {
    await group.updateName(name);
    warmGroupName(group.id, name);
  }
  if (
    typeof description === 'string' &&
    typeof group.updateDescription === 'function'
  ) {
    await group.updateDescription(description);
  }

  let merged: Record<string, unknown> | undefined;
  if (appData && typeof appData === 'object' && !Array.isArray(appData)) {
    const res = mergeAppData(group.appData, appData);
    await group.updateAppData(res.blob);
    merged = res.merged;
  } else {
    merged = readAppData(group.appData);
  }

  const labels = Array.isArray(merged.labels)
    ? (merged.labels as string[])
    : [];
  const github = typeof merged.github === 'string' ? merged.github : undefined;
  const preview =
    typeof merged.preview === 'string' ? merged.preview : undefined;
  return {
    line,
    id: group.id,
    account: acct.cfg.id,
    ...(typeof name === 'string' && name ? { name } : {}),
    labels,
    github,
    preview,
    appData: merged,
  };
}

export async function updateChannelMeta(id: string, args: Args): Promise<void> {
  const line = resolveLine(args, 'updateChannelMeta');
  const { name, description, appData } = args as {
    name?: string;
    description?: string;
    appData?: Record<string, unknown>;
  };
  const result = await applyChannelMeta(
    { line, name, description, appData },
    'updateChannelMeta',
  );
  respond(id, { result });
}
