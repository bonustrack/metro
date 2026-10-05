import { accountForCall, convOf, lineOf, parseLine } from './accounts.js';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { ethIdentifiers, warmGroupName } from './conv-helpers.js';
import { mergeAppData, normalizeAssigned, readAppDataObject, type GroupLike } from './labels.js';
import { TrainError } from '@metro-labs/core/train-error';
import { syncConversation } from './network.js';

type Args = Record<string, unknown>;

function resolveLine(args: Args, verb: string): string {
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
  return readAppDataObject(group.appData);
}

async function applyChannelMeta(
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
  await syncConversation(acct.client, conv);
  if (appData) mergeAppData(group.appData, appData);
  else readAppDataObject(group.appData);
  if (appData && Object.hasOwn(appData, 'assigned')) {
    const assigned = normalizeAssigned(appData.assigned);
    const inboxIds = await Promise.all(
      ethIdentifiers(assigned).map((identifier) => acct.client.fetchInboxIdByIdentifier(identifier)),
    );
    const members = new Set((await conv.members()).map((member) => member.inboxId));
    if (inboxIds.some((inboxId) => !inboxId || !members.has(inboxId))) {
      throw new TrainError('INVALID_ARGS', 'Assignees must be current channel members');
    }
  }

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
  category: string | undefined;
  status: string | undefined;
  priority: string | undefined;
  github: string | undefined;
  preview: string | undefined;
  assigned: unknown;
} {
  return {
    labels: Array.isArray(merged.labels) ? (merged.labels as string[]) : [],
    category: typeof merged.category === 'string' ? merged.category : undefined,
    status: typeof merged.status === 'string' ? merged.status : undefined,
    priority: typeof merged.priority === 'string' ? merged.priority : undefined,
    github: typeof merged.github === 'string' ? merged.github : undefined,
    preview: typeof merged.preview === 'string' ? merged.preview : undefined,
    assigned: Object.hasOwn(merged, 'assigned') ? merged.assigned : [],
  };
}

const metadataWrites = new Map<string, Promise<Record<string, unknown>>>();

export async function updateChannelMeta(id: string, args: Args): Promise<void> {
  const line = resolveLine(args, 'updateChannelMeta');
  const parsed = parseLine(line);
  if (!parsed) throw new TrainError('INVALID_ARGS', `bad xmtp line: ${line}`);
  const key = lineOf(parsed.accountId, parsed.convId);
  const { name, description, appData } = args as {
    name?: string;
    description?: string;
    appData?: Record<string, unknown>;
  };
  if (name !== undefined && typeof name !== 'string') {
    throw new TrainError('INVALID_ARGS', 'name must be a string');
  }
  const task = () => applyChannelMeta({ line, name, description, appData }, 'updateChannelMeta');
  const previous = metadataWrites.get(key);
  const pending = previous ? previous.then(task, task) : task();
  metadataWrites.set(key, pending);
  try {
    respond(id, { result: await pending });
  } finally {
    if (metadataWrites.get(key) === pending) metadataWrites.delete(key);
  }
}
