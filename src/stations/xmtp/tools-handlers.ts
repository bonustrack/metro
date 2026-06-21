import type { ToolContext } from '../types.js';

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function strList(value: unknown): string[] {
  return (value as unknown[] | undefined)?.map(String).filter(Boolean) ?? [];
}

interface CreatedGroup {
  line?: string;
  id?: string;
  account?: string;
}

async function applyCreateLabels(
  line: string,
  labels: string[],
  ctx: ToolContext,
): Promise<unknown> {
  if (!labels.length) return undefined;
  return ctx.call('updateChannelMeta', { line, appData: { labels } });
}

export async function createChannel(
  a: Record<string, unknown>,
  ctx: ToolContext,
) {
  const addresses = strList(a.addresses);
  const channelName = str(a.name);
  const labels = strList(a.labels);
  const account = str(a.account) || undefined;
  if (!addresses.length)
    return ctx.err('create_channel requires a non-empty `addresses` array');
  if (!channelName) return ctx.err('create_channel requires `name`');
  const groupArgs: Record<string, unknown> = { addresses, name: channelName };
  if (account) groupArgs.account = account;
  const created = (await ctx.call('newGroup', groupArgs)) as CreatedGroup | null;
  const newLine = created?.line ?? '';
  const labelResult = newLine.length
    ? await applyCreateLabels(newLine, labels, ctx)
    : undefined;
  return ctx.okJson({
    line: newLine,
    convId: created?.id,
    account: created?.account,
    labels: labelResult,
  });
}

export async function setChannelMetadata(
  a: Record<string, unknown>,
  ctx: ToolContext,
) {
  const line = str(a.line);
  if (!line) return ctx.err('set_channel_metadata requires `line`');
  const labels = a.labels as unknown[] | undefined;
  const github = a.github as string | undefined;
  const preview = a.preview as string | undefined;
  const metaName = a.name as string | undefined;
  const appData: Record<string, unknown> = {};
  if (Array.isArray(labels)) appData.labels = labels.map(String);
  if (typeof github === 'string') appData.github = github;
  if (typeof preview === 'string') appData.preview = preview;
  const hasName = typeof metaName === 'string' && metaName.length > 0;
  if (!hasName && Object.keys(appData).length === 0)
    return ctx.err(
      'set_channel_metadata requires at least one of `labels`, `github`, `preview`, `name`',
    );
  const callArgs: Record<string, unknown> = { line, appData };
  if (hasName) callArgs.name = metaName;
  return ctx.okJson(await ctx.call('updateChannelMeta', callArgs));
}

export async function memberOp(
  tool: string,
  action: string,
  a: Record<string, unknown>,
  ctx: ToolContext,
) {
  const line = str(a.line);
  if (!line) return ctx.err(`${tool} requires \`line\``);
  const addresses = strList(a.addresses);
  const inboxIds = strList(a.inboxIds);
  if (!addresses.length && !inboxIds.length)
    return ctx.err(`${tool} requires \`addresses\` or \`inboxIds\``);
  const args: Record<string, unknown> = { line };
  if (addresses.length) args.addresses = addresses;
  if (inboxIds.length) args.inboxIds = inboxIds;
  return ctx.okJson(await ctx.call(action, args));
}
