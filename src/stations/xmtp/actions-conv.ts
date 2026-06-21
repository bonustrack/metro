import { IdentifierKind } from '@xmtp/node-sdk';
import {
  accounts,
  accountForCall,
  convOf,
  lineOf,
  parseLine,
  type Account,
} from './accounts.js';
import { inboxEthCache, respond } from './wire.js';
import { TrainError } from '../../train-error.js';
import { warmGroupName } from './conv-name.js';
import { pushHandlers } from './actions-push.js';
import {
  cleanLabels,
  labelsBlob,
  readAppData,
  type GroupLike,
} from './labels.js';
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
    addresses.map((a) => ({
      identifier: a,
      identifierKind: IdentifierKind.Ethereum,
    })),
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

async function createRequestGroup(id: string, args: Args): Promise<void> {
  const { memberAddresses, memberInboxIds, name, description, labels } =
    args as {
      memberAddresses?: string[];
      memberInboxIds?: string[];
      name: string;
      description?: string;
      labels?: string[];
    };
  const acct = accountForCall(args);
  if (!name || typeof name !== 'string')
    throw new TrainError(
      'INVALID_ARGS',
      'createRequestGroup requires a `name`',
    );
  const addrs = (memberAddresses ?? []).filter(
    (a) => typeof a === 'string' && a.length > 0,
  );
  const inboxes = (memberInboxIds ?? []).filter(
    (a) => typeof a === 'string' && a.length > 0,
  );
  if (addrs.length === 0 && inboxes.length === 0) {
    throw new TrainError(
      'INVALID_ARGS',
      'createRequestGroup requires memberAddresses[] or memberInboxIds[]',
    );
  }
  const opts: {
    groupName: string;
    groupDescription?: string;
    appData?: string;
  } = { groupName: name };
  if (description) opts.groupDescription = description;
  if (Array.isArray(labels) && labels.length)
    opts.appData = labelsBlob(undefined, labels);

  let group: GroupLike;
  if (addrs.length) {
    const created = await acct.client.conversations.createGroupWithIdentifiers(
      addrs.map((a) => ({
        identifier: a,
        identifierKind: IdentifierKind.Ethereum,
      })),
      opts,
    );
    group = created;
    if (inboxes.length) {
      await (
        created as unknown as {
          addMembers: (ids: string[]) => Promise<unknown>;
        }
      ).addMembers(inboxes);
    }
  } else {
    const created = await acct.client.conversations.createGroup(inboxes, opts);
    group = created;
  }

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

async function buildGroupInfo(
  line: string,
  acct: Account,
  conv: Awaited<ReturnType<typeof convOf>>['conv'] & object,
): Promise<Record<string, unknown>> {
  const inboxIds = (await conv.members()).map((m) => m.inboxId);
  const addresses: Record<string, string> = {};
  const missing = inboxIds.filter((iid) => {
    const cached = inboxEthCache.get(iid);
    if (cached) {
      addresses[iid] = cached;
      return false;
    }
    return true;
  });
  if (missing.length) {
    try {
      const states = await acct.client.preferences.fetchInboxStates(missing);
      for (let i = 0; i < missing.length; i++) {
        const eth = states[i]?.identifiers.find(
          (it: { identifierKind: IdentifierKind }) =>
            it.identifierKind === IdentifierKind.Ethereum,
        );
        if (eth?.identifier) {
          addresses[missing[i]] = eth.identifier;
          inboxEthCache.set(missing[i], eth.identifier);
        }
      }
    } catch {
    }
  }
  const isDm =
    typeof (conv as unknown as { peerInboxId?: unknown }).peerInboxId ===
    'function';
  const groupName = (
    conv as unknown as { name?: string | (() => Promise<string>) }
  ).name;
  const resolvedName =
    typeof groupName === 'function' ? await groupName() : (groupName ?? '');
  const { labels, github, preview } = readAppData(
    (conv as unknown as GroupLike).appData,
  );
  return {
    line,
    id: conv.id,
    account: acct.cfg.id,
    version: isDm ? 'dm' : 'group',
    name: resolvedName ?? '',
    memberCount: inboxIds.length,
    labels,
    github,
    preview,
    members: inboxIds.map((iid) => ({
      inboxId: iid,
      address: addresses[iid] ?? null,
    })),
  };
}

async function addMembers(id: string, args: Args): Promise<void> {
  const { line, addresses, inboxIds } = args as {
    line: string;
    addresses?: string[];
    inboxIds?: string[];
  };
  if (!line || typeof line !== 'string') {
    throw new TrainError('INVALID_ARGS', 'addMembers requires a `line`');
  }
  const addrs = (addresses ?? []).filter(
    (a) => typeof a === 'string' && a.length > 0,
  );
  const inboxes = (inboxIds ?? []).filter(
    (a) => typeof a === 'string' && a.length > 0,
  );
  if (addrs.length === 0 && inboxes.length === 0) {
    throw new TrainError(
      'INVALID_ARGS',
      'addMembers requires addresses[] or inboxIds[]',
    );
  }
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  const group = conv as unknown as GroupLike & {
    addMembers?: (ids: string[]) => Promise<unknown>;
    addMembersByIdentifiers?: (
      ids: { identifier: string; identifierKind: IdentifierKind }[],
    ) => Promise<unknown>;
  };
  if (
    typeof group.addMembers !== 'function' &&
    typeof group.addMembersByIdentifiers !== 'function'
  ) {
    throw new TrainError(
      'INVALID_ARGS',
      'addMembers target is not a group (no addMembers)',
    );
  }
  await group.sync?.().catch(() => undefined);
  if (addrs.length) {
    if (typeof group.addMembersByIdentifiers !== 'function') {
      throw new TrainError(
        'INVALID_ARGS',
        'group does not support addMembersByIdentifiers; pass inboxIds instead',
      );
    }
    await group.addMembersByIdentifiers(
      addrs.map((a) => ({
        identifier: a,
        identifierKind: IdentifierKind.Ethereum,
      })),
    );
  }
  if (inboxes.length) {
    if (typeof group.addMembers !== 'function') {
      throw new TrainError(
        'INVALID_ARGS',
        'group does not support addMembers by inboxId',
      );
    }
    await group.addMembers(inboxes);
  }
  const info = await buildGroupInfo(line, acct, conv);
  respond(id, {
    result: { ...info, added: { addresses: addrs, inboxIds: inboxes } },
  });
}

async function removeMembers(id: string, args: Args): Promise<void> {
  const { line, addresses, inboxIds } = args as {
    line: string;
    addresses?: string[];
    inboxIds?: string[];
  };
  if (!line || typeof line !== 'string') {
    throw new TrainError('INVALID_ARGS', 'removeMembers requires a `line`');
  }
  const addrs = (addresses ?? []).filter(
    (a) => typeof a === 'string' && a.length > 0,
  );
  const inboxes = (inboxIds ?? []).filter(
    (a) => typeof a === 'string' && a.length > 0,
  );
  if (addrs.length === 0 && inboxes.length === 0) {
    throw new TrainError(
      'INVALID_ARGS',
      'removeMembers requires addresses[] or inboxIds[]',
    );
  }
  const { acct, conv } = await convOf(line);
  if (!conv)
    throw new TrainError('NOT_FOUND', `conversation not found for ${line}`);
  const group = conv as unknown as GroupLike & {
    removeMembers?: (ids: string[]) => Promise<unknown>;
    removeMembersByIdentifiers?: (
      ids: { identifier: string; identifierKind: IdentifierKind }[],
    ) => Promise<unknown>;
  };
  if (
    typeof group.removeMembers !== 'function' &&
    typeof group.removeMembersByIdentifiers !== 'function'
  ) {
    throw new TrainError(
      'INVALID_ARGS',
      'removeMembers target is not a group (no removeMembers)',
    );
  }
  await group.sync?.().catch(() => undefined);
  if (addrs.length) {
    if (typeof group.removeMembersByIdentifiers !== 'function') {
      throw new TrainError(
        'INVALID_ARGS',
        'group does not support removeMembersByIdentifiers; pass inboxIds instead',
      );
    }
    await group.removeMembersByIdentifiers(
      addrs.map((a) => ({
        identifier: a,
        identifierKind: IdentifierKind.Ethereum,
      })),
    );
  }
  if (inboxes.length) {
    if (typeof group.removeMembers !== 'function') {
      throw new TrainError(
        'INVALID_ARGS',
        'group does not support removeMembers by inboxId',
      );
    }
    await group.removeMembers(inboxes);
  }
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
  const inboxIds = (await conv.members()).map((m) => m.inboxId);
  const addresses: Record<string, string> = {};
  const missing = inboxIds.filter((iid) => {
    const cached = inboxEthCache.get(iid);
    if (cached) {
      addresses[iid] = cached;
      return false;
    }
    return true;
  });
  if (missing.length) {
    try {
      const states = await acct.client.preferences.fetchInboxStates(missing);
      for (let i = 0; i < missing.length; i++) {
        const eth = states[i]?.identifiers.find(
          (it: { identifierKind: IdentifierKind }) =>
            it.identifierKind === IdentifierKind.Ethereum,
        );
        if (eth?.identifier) {
          addresses[missing[i]] = eth.identifier;
          inboxEthCache.set(missing[i], eth.identifier);
        }
      }
    } catch {
    }
  }
  const isDm =
    typeof (conv as unknown as { peerInboxId?: unknown }).peerInboxId ===
    'function';
  const groupName = (
    conv as unknown as { name?: string | (() => Promise<string>) }
  ).name;
  const resolvedName =
    typeof groupName === 'function' ? await groupName() : (groupName ?? '');
  const { labels, github, preview } = readAppData(
    (conv as unknown as GroupLike).appData,
  );
  respond(id, {
    result: {
      line,
      id: conv.id,
      account: acct.cfg.id,
      version: isDm ? 'dm' : 'group',
      name: resolvedName ?? '',
      memberCount: inboxIds.length,
      labels,
      github,
      preview,
      members: inboxIds.map((iid) => ({
        inboxId: iid,
        address: addresses[iid] ?? null,
      })),
    },
  });
}

async function summarizeConv(
  acct: Account,
  c: Awaited<ReturnType<typeof convOf>>['conv'] & object,
): Promise<unknown> {
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
