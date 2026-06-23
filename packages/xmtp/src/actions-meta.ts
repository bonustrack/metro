import { accountForCall, convOf, lineOf } from './accounts.js';
import { respond } from './wire.js';
import { warmGroupName } from './conv-helpers.js';
import { mergeAppData, readAppData, type GroupLike } from './labels.js';
import { TrainError } from '@metro-labs/metro/train-error';

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

async function applyNameAndDescription(
  group: GroupLike,
  name: string | undefined,
  description: string | undefined,
): Promise<void> {
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
}

async function applyMergedAppData(
  group: GroupLike & { updateAppData: (s: string) => Promise<void> },
  appData: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  if (appData && typeof appData === 'object' && !Array.isArray(appData)) {
    const res = mergeAppData(group.appData, appData);
    await group.updateAppData(res.blob);
    return res.merged;
  }
  return readAppData(group.appData);
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

  await applyNameAndDescription(group, name, description);
  const merged = await applyMergedAppData(
    group as GroupLike & { updateAppData: (s: string) => Promise<void> },
    appData,
  );

  return {
    line,
    id: group.id,
    account: acct.cfg.id,
    ...(typeof name === 'string' && name ? { name } : {}),
    ...metaFields(merged),
    appData: merged,
  };
}

function metaFields(merged: Record<string, unknown>): {
  labels: string[];
  github: string | undefined;
  preview: string | undefined;
} {
  return {
    labels: Array.isArray(merged.labels) ? (merged.labels as string[]) : [],
    github: typeof merged.github === 'string' ? merged.github : undefined,
    preview: typeof merged.preview === 'string' ? merged.preview : undefined,
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

export async function setGithub(id: string, args: Args): Promise<void> {
  const line = resolveLine(args, 'setGithub');
  const { url } = args as { url: string };
  if (typeof url !== 'string')
    throw new Error('setGithub requires a `url` string');
  const result = await applyChannelMeta(
    { line, appData: { github: url } },
    'setGithub',
  );
  respond(id, {
    result: {
      line: result.line,
      id: result.id,
      account: result.account,
      github: result.github,
    },
  });
}

export async function setPreview(id: string, args: Args): Promise<void> {
  const line = resolveLine(args, 'setPreview');
  const a = args as { preview?: unknown; url?: unknown };
  const value = typeof a.preview === 'string' ? a.preview : a.url;
  if (typeof value !== 'string')
    throw new Error('setPreview requires a `preview` string');
  const result = await applyChannelMeta(
    { line, appData: { preview: value } },
    'setPreview',
  );
  respond(id, {
    result: {
      line: result.line,
      id: result.id,
      account: result.account,
      preview: result.preview,
    },
  });
}
