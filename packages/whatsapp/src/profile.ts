import { jidNormalizedUser, type WASocket } from 'baileys';
import { isRecord } from '@metro-labs/core/is-record';
import { nonEmpty, type SenderProfile } from '@metro-labs/core/stations/sender-profile';
import { phoneOf, type NameBook } from './names.js';

export const NO_PICTURE_MS = 6 * 60 * 60_000;
const PICTURE_WAIT_MS = 3_000;
const NO_PICTURE_MAX = 2_000;
const REFUSED = new Set([401, 403, 404]);

type ProfileSocket = Pick<WASocket, 'fetchStatus' | 'profilePictureUrl' | 'signalRepository'>;

export interface PeerProfile {
  profile: SenderProfile;
  other: string | null;
}

export class NoPictures {
  private seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  known(jid: string): boolean {
    const at = this.seen.get(jid);
    if (at === undefined) return false;
    if (this.now() - at < NO_PICTURE_MS) return true;
    this.seen.delete(jid);
    return false;
  }

  remember(jid: string): void {
    this.seen.delete(jid);
    this.seen.set(jid, this.now());
    if (this.seen.size <= NO_PICTURE_MAX) return;
    const oldest = this.seen.keys().next();
    if (!oldest.done) this.seen.delete(oldest.value);
  }
}

function refusal(err: unknown): boolean {
  const output = isRecord(err) && isRecord(err.output) ? err.output : {};
  return typeof output.statusCode === 'number' && REFUSED.has(output.statusCode);
}

async function otherIdOf(sock: ProfileSocket, jid: string): Promise<string | null> {
  const mapping = sock.signalRepository.lidMapping;
  const other = await (jid.endsWith('@lid') ? mapping.getPNForLID(jid) : mapping.getLIDForPN(jid)).catch(() => null);
  return other === null ? null : jidNormalizedUser(other);
}

async function pictureFor(sock: ProfileSocket, jid: string, none: NoPictures): Promise<{ url?: string; refused: boolean }> {
  let refused = true;
  for (const type of ['image', 'preview'] as const) {
    try {
      const url = nonEmpty(await sock.profilePictureUrl(jid, type, PICTURE_WAIT_MS));
      if (url !== undefined) return { url, refused: false };
    } catch (err) {
      if (!refusal(err)) refused = false;
    }
  }
  if (refused) none.remember(jid);
  return { refused };
}

export async function pictureOf(sock: ProfileSocket, jids: string[], none: NoPictures): Promise<string | undefined> {
  for (const jid of jids) {
    if (none.known(jid)) continue;
    const found = await pictureFor(sock, jid, none);
    if (found.url !== undefined) return found.url;
  }
  return undefined;
}

export async function readPeer(sock: ProfileSocket, jid: string, none: NoPictures): Promise<PeerProfile> {
  const other = await otherIdOf(sock, jid);
  const jids = other === null ? [jid] : [jid, other];
  const [statuses, picture] = await Promise.all([sock.fetchStatus(jid).catch(() => undefined), pictureOf(sock, jids, none)]);
  const status: unknown = statuses?.[0]?.status;
  const about = nonEmpty(isRecord(status) ? status.status : undefined);
  const phone = phoneOf(jid.endsWith('@lid') ? other : jid);
  return {
    other,
    profile: {
      id: jid,
      ...(phone === undefined ? {} : { name: phone, address: phone }),
      ...(about === undefined ? {} : { about }),
      ...(picture === undefined ? {} : { avatar: picture }),
    },
  };
}

export function withName(peer: PeerProfile, names: NameBook): SenderProfile {
  const { profile, other } = peer;
  if (other !== null) names.alias(profile.id.endsWith('@lid') ? other : profile.id, profile.id.endsWith('@lid') ? profile.id : other);
  const name = names.get(profile.id) ?? (other === null ? undefined : names.get(other));
  return name === undefined ? profile : { ...profile, display_name: name };
}
