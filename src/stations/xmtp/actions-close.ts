import { accountForCall, convOf, lineOf, type Account } from './accounts.js';
import { respond } from './wire.js';
import type { GroupLike } from './labels.js';

type Args = Record<string, unknown>;

async function removeSelfFromGroup(
  id: string,
  group: GroupLike & { removeMembers: (ids: string[]) => Promise<void> },
  acct: Account,
  resolvedLine: string,
  removed: string[],
): Promise<boolean> {
  try {
    await group.removeMembers([acct.inboxId]);
    return true;
  } catch (e) {
    respond(id, {
      result: {
        line: resolvedLine,
        id: group.id,
        account: acct.cfg.id,
        removed,
        leftSelf: false,
        selfRemovalError: `self-removal not supported: ${(e as Error).message}`,
      },
    });
    return false;
  }
}

type ClosableGroup = GroupLike & {
  removeMembers: (ids: string[]) => Promise<void>;
};

async function resolveCloseTarget(
  id: string,
  args: Args,
  acct: Account,
): Promise<{ group: ClosableGroup; resolvedLine: string } | null> {
  const { line, groupId } = args as { line?: string; groupId?: string };
  const resolvedLine =
    line ?? (groupId ? lineOf(acct.cfg.id, groupId) : undefined);
  if (!resolvedLine) {
    respond(id, { error: 'closeGroup requires `line` or `groupId`' });
    return null;
  }
  const { conv } = await convOf(resolvedLine);
  if (!conv) {
    respond(id, { error: `conversation not found for ${resolvedLine}` });
    return null;
  }
  const group = conv as unknown as ClosableGroup;
  if (typeof group.removeMembers !== 'function') {
    respond(id, {
      error: 'closeGroup target is not a group (no removeMembers)',
    });
    return null;
  }
  await group.sync?.().catch(() => undefined);
  return { group, resolvedLine };
}

export async function closeGroup(id: string, args: Args): Promise<void> {
  const { removeInboxIds, removeSelf } = args as {
    removeInboxIds?: string[];
    removeSelf?: boolean;
  };
  const acct = accountForCall(args);
  const target = await resolveCloseTarget(id, args, acct);
  if (!target) return;
  const { group, resolvedLine } = target;
  const removeMembers = group.removeMembers.bind(group);

  const others = (removeInboxIds ?? []).filter(
    (iid) => typeof iid === 'string' && iid && iid !== acct.inboxId,
  );
  const removed: string[] = [];
  let leftSelf = false;
  try {
    if (others.length) {
      await removeMembers(others);
      removed.push(...others);
    }
    if (removeSelf) {
      leftSelf = await removeSelfFromGroup(
        id,
        group,
        acct,
        resolvedLine,
        removed,
      );
      if (!leftSelf) return;
    }
  } catch (err) {
    respond(id, { error: (err as Error).message });
    return;
  }

  respond(id, {
    result: {
      line: resolvedLine,
      id: group.id,
      account: acct.cfg.id,
      removed,
      leftSelf,
    },
  });
}
