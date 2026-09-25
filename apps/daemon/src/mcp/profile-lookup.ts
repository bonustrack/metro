import type { ToolDef } from './tool-def.js';
import { Line } from '@metro-labs/core/lines';
import type { Station, ToolResult } from '@metro-labs/core/stations/types';
import { str } from '@metro-labs/core/str';
import { stationByName } from '../stations/registry.js';
import { errResult, makeCtx, okJson, toErr } from './ctx.js';

export const GET_PROFILE_TOOL: ToolDef = {
  name: 'get_profile',
  group: 'read',
  description:
    'Who is this person? Give the `from` attribute of one of their messages verbatim ' +
    '(`metro://<station>/<account>/user/<id>`) and get what their network says about them: ' +
    '{id, name, display_name, about, avatar, address}. XMTP answers the Basename ' +
    '(<label>.stage.base.eth), its name, description and avatar records, and the wallet address; ' +
    'WhatsApp the phone number, the name they last used, the about line and the picture; Telegram the handle, the name and the bio; Discord ' +
    'the username, the global name and the avatar. Fields the network does not have are absent. ' +
    'The answer is cached for ten minutes, so ask when you want to know someone, not on every message.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'The `from` of a message, exactly as received.' },
    },
    required: ['from'],
  },
};

export interface ProfileTarget {
  station: Station;
  account: string;
  user: string;
}

export function profileTarget(a: Record<string, unknown>): ProfileTarget | { refused: string } {
  const from = str(a.from);
  if (!from) return { refused: 'get_profile requires `from`' };
  const parsed = Line.parse(from);
  const at = parsed?.path.indexOf('user') ?? -1;
  if (parsed === null || at < 1 || at + 1 >= parsed.path.length) return { refused: `${from} is not a person: expected metro://<station>/<account>/user/<id>` };
  const station = stationByName(parsed.station);
  if (!station) return { refused: `no station named ${parsed.station}` };
  if (station.readsProfiles !== true) return { refused: `${station.name} has no profile metro can read` };
  return { station, account: parsed.path.slice(0, at).join('/'), user: parsed.path.slice(at + 1).join('/') };
}

export const profileScopeLine = (a: Record<string, unknown>): string | undefined => {
  const target = profileTarget(a);
  return 'refused' in target ? undefined : `metro://${target.station.name}/${target.account}/user/${target.user}`;
};

export async function dispatchGetProfile(a: Record<string, unknown>): Promise<ToolResult> {
  const target = profileTarget(a);
  if ('refused' in target) return errResult(target.refused);
  try {
    const { result } = await makeCtx(target.station.name).call('profile', { account: target.account, user: target.user });
    return okJson(result);
  } catch (e) {
    return toErr('get_profile', e);
  }
}
