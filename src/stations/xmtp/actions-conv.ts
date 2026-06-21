import { IdentifierKind } from '@xmtp/node-sdk';
import {
  accounts,
  accountForCall,
  convOf,
  lineOf,
  parseLine,
  type Account,
} from './accounts.js';
import { respond } from './wire.js';
import { TrainError } from '../../train-error.js';
import { warmGroupName } from './conv-name.js';
import { pushHandlers } from './actions-push.js';
import { cleanLabels, labelsBlob, type GroupLike } from './labels.js';
import {
  applyMemberOp,
  buildGroupInfo,
  ethIdentifiers,
  parseMemberArgs,
  resolveMembers,
} from './conv-helpers.js';
import { closeGroup } from './actions-close.js';
import { setGithub } from './actions-github.js';
import { setPreview } from './actions-preview.js';
import {
  updateChannelMeta,
  applyChannelMeta,
  resolveLine,
} from './actions-meta.js';

type Args = Record<string, unknown>;
type Handler = (id: string, args: Args) => Promise<void>;
type Conv = Awaited<ReturnType<typeof convOf>>['conv'] & object;

async function newDm(id: string, args: Args): Promise<void> {
  const { address } = args as { address: string };
  const acct = accountForCall(args);
  const dm = await acct.client.conversations.createDmWithIdentifier({
    identifier: address,
    identifierKind: IdentifierKind.Ethereum,
  });
  respond(id, {
    result: {
      line: lineOf(acct.cfg.id, dm.id),
      id: dm.id,
      account: acct.cfg.id,
    },
  });
}

async function newGroup(id: string, args: Args): Promise<void> {
  const { addresses, name, permissions } = args as {
    addresses: string[];
    name?: string;
    permissions?: 'admin-only' | 'default';
  };
  const acct = accountForCall(args);
  const opts: { groupName?: string; permissions?: number } = {};
  if (name) opts.groupName = name;
  if (permissions === 'admin-only') opts.permissions = 1;
  const group = await acct.client.conversations.createGroupWithIdentifiers(
    ethIdentifiers(addresses),
    opts,
  );
  warmGroupName(group.id, name);
  respond(id, {
    result: {
      line: lineOf(acct.cfg.id, group.id),
      id: group.id,
      account: acct.cfg.id,
    },
  });
}

async function createGroupWithMembers(
  acct: Account,
  addrs: string[],
  inboxes: string[],
  opts: { groupName: string; groupDescription?: string; appData?: string },
): Promise<GroupLike> {
  if (!addrs.length)
    return acct.client.conversations.createGroup(inboxes, opts);
  const created = await acct.client.conversations.createGroupWithIdentifiers(
    ethIdentifiers(addrs),
    opts,
  );
  if (inboxes.length)
    await (
      created as unknown as { addMembers: (ids: string[]) => Promise<unknown> }
    ).addMembers(inboxes);
  return created;
}

async function createRequestGroup(id: string, args: Args): Promise<void> {
  const { name, description, labels } = args as {
    name: string;
    description?: string;
    labels?: string[];
  };
  const acct = accountForCall(args);
  if (!name || typeof name !== 'string')
    throw new TrainError('INVALID_ARGS', 'createRequestGroup requires a `name`');
  const { addrs, inboxes } = resolveMembers(args);
  if (addrs.length === 0 && inboxes.length === 0)
    throw new TrainError(
      'INVALID_ARGS',
      'createRequestGroup requires addresses[] or inboxIds[]',
    );
  const opts: {
    groupName: string;
    groupDescription?: string;
    appData?: string;
  } = { groupName: name };
  if (description) opts.groupDescription = description;
  if (Array.isArray(labels) && labels.length)
    opts.appData = labelsBlob(undefined, labels);

  const group = await createGroupWithMembers(acct, addrs, inboxes, opts);
  warmGroupName(group.id, name);
  respond(id, {
    result: {
      line: lineOf(acct.cfg.id, group.id),
      id: group.id,
      account: acct.cfg.id,
      name,
      description: description ?? '',
      labels: cleanLabels(labels ?? []),
    },
  });
}

async function setLabels(id: string, args: Args): Promise<void> {
  const { labels, setName, setDescription, setGithub } = args as {
    line?: string;
    groupId?: string;
    labels: string[];
    setName?: string;
    setDescription?: string;
    setGithub?: string;
  };
  const resolvedLine = resolveLine(args, 'setLabels');
  if (!Array.isArray(labels))
    throw new TrainError('INVALID_ARGS', 'setLabels requires a `labels` array');
  const appData: Record<string, unknown> = { labels };
  if (typeof setGithub === 'string') appData.github = setGithub;
  const result = await applyChannelMeta(
    { line: resolvedLine, name: setName, description: setDescription, appData },
    'setLabels',
  );
  respond(id, {
    result: {
      line: result.line,
      id: result.id,
      account: result.account,
      labels: result.labels,
    },
  });
}

async function query(id: string, args: Args): Promise<void> {
  const { line, limit } = args as { line: string; limit?: number };
  const { conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  const lim = Math.min(Math.max(1, limit ?? 20), 200);
  await conv.sync().catch(() => undefined);
  const all = await conv.messages();
  const slice = all.slice(-lim);
  const parsed = parseLine(line);
  if (!parsed)
    throw new TrainError('NOT_FOUND', `could not parse line ${line}`);
  const acctId = parsed.accountId;
  const messages = slice.map((m) => {
    let text = '';
    try {
      const cc: unknown = m.content;
      text =
        typeof cc === 'string' ? cc : `[${m.contentType?.typeId ?? 'unknown'}]`;
    } catch {
      text = `[${m.contentType?.typeId ?? 'unknown'}]`;
    }
    return {
      id: m.id,
      ts: new Date(Number(m.sentAtNs / 1_000_000n)).toISOString(),
      from: `metro://xmtp/${acctId}/user/${m.senderInboxId}`,
      text,
      contentType: m.contentType?.typeId ?? 'unknown',
    };
  });
  respond(id, { result: { line, count: messages.length, messages } });
}

async function addMembers(id: string, args: Args): Promise<void> {
  const { line, addrs, inboxes } = parseMemberArgs(args, 'addMembers');
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  await applyMemberOp(conv, addrs, inboxes, 'add');
  const info = await buildGroupInfo(line, acct, conv);
  respond(id, {
    result: { ...info, added: { addresses: addrs, inboxIds: inboxes } },
  });
}

async function removeMembers(id: string, args: Args): Promise<void> {
  const { line, addrs, inboxes } = parseMemberArgs(args, 'removeMembers');
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  await applyMemberOp(conv, addrs, inboxes, 'remove');
  const info = await buildGroupInfo(line, acct, conv);
  respond(id, {
    result: { ...info, removed: { addresses: addrs, inboxIds: inboxes } },
  });
}

async function groupInfo(id: string, args: Args): Promise<void> {
  const { line } = args as { line: string };
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  respond(id, { result: await buildGroupInfo(line, acct, conv) });
}

async function summarizeConv(acct: Account, c: Conv): Promise<unknown> {
  const recent = await c.messages({ limit: 1, direction: 1 }).catch(() => []);
  const last = recent[0];
  let preview = '';
  if (last) {
    const cc: unknown = last.content;
    preview =
      typeof cc === 'string'
        ? cc.slice(0, 80)
        : `[${last.contentType?.typeId ?? 'unknown'}]`;
  }
  const isDm =
    typeof (c as unknown as { peerInboxId?: unknown }).peerInboxId ===
    'function';
  const gn = (c as unknown as { name?: string | (() => Promise<string>) }).name;
  const resolvedName =
    typeof gn === 'function' ? await gn().catch(() => '') : (gn ?? '');
  return {
    line: lineOf(acct.cfg.id, c.id),
    id: c.id,
    account: acct.cfg.id,
    version: isDm ? 'dm' : 'group',
    name: resolvedName ?? '',
    lastTs: last
      ? new Date(Number(last.sentAtNs / 1_000_000n)).toISOString()
      : null,
    lastPreview: preview,
  };
}

async function listConvs(id: string, args: Args): Promise<void> {
  const { limit, account } = args as { limit?: number; account?: string };
  const lim = Math.min(Math.max(1, limit ?? 50), 200);
  const targets = account
    ? [accounts.get(account)].filter((a): a is Account => a !== undefined)
    : [...accounts.values()];
  const summaries: unknown[] = [];
  for (const acct of targets) {
    await acct.client.conversations.syncAll();
    const all = await acct.client.conversations.list();
    for (const c of all.slice(0, lim))
      summaries.push(await summarizeConv(acct, c));
  }
  summaries.sort((a, b) =>
    ((b as { lastTs?: string }).lastTs ?? '').localeCompare(
      (a as { lastTs?: string }).lastTs ?? '',
    ),
  );
  respond(id, {
    result: { count: summaries.length, conversations: summaries.slice(0, lim) },
  });
}

export const convHandlers: Record<string, Handler> = {
  newDm,
  newGroup,
  createRequestGroup,
  addMembers,
  removeMembers,
  setLabels,
  setGithub,
  setPreview,
  updateChannelMeta,
  closeGroup,
  query,
  groupInfo,
  listConvs,
  ...pushHandlers,
};
