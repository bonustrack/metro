import { respond } from './wire.js';
import { applyChannelMeta, resolveLine } from './actions-meta.js';

type Args = Record<string, unknown>;

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
