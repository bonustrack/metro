import type { GroupMetadata, GroupParticipant } from 'baileys';
import { TrainError } from '@metro-labs/core/train-error';
import type { MemberCapability, MemberList, MetroMember } from '@metro-labs/core/stations/types';
import { isGroupJid } from './parse.js';
import { phoneOf, type NameBook } from './names.js';

interface WhatsAppMember extends MetroMember {
  lid?: string;
  phoneNumber?: string;
}

function memberName(p: GroupParticipant, names: NameBook): string | undefined {
  return names.get(p.id) ?? p.name ?? p.notify
    ?? (p.lid ? names.get(p.lid) : undefined)
    ?? (p.phoneNumber ? names.get(p.phoneNumber) : undefined);
}

function memberRole(p: GroupParticipant): string | undefined {
  return p.admin ?? (p.isSuperAdmin ? 'superadmin' : p.isAdmin ? 'admin' : undefined);
}

function memberOf(p: GroupParticipant, names: NameBook): WhatsAppMember {
  const lid = p.id.endsWith('@lid') ? p.id : p.lid;
  const phoneNumber = p.id.endsWith('@s.whatsapp.net') ? p.id : p.phoneNumber;
  const displayName = memberName(p, names);
  const address = phoneOf(phoneNumber);
  const role = memberRole(p);
  return {
    id: p.id,
    ...(displayName ? { display_name: displayName } : {}),
    ...(lid ? { lid } : {}),
    ...(phoneNumber ? { phoneNumber } : {}),
    ...(address ? { address } : {}),
    roles: role ? [role] : [],
    is_admin: role === 'admin' || role === 'superadmin',
  };
}

function memberLimit(limit: number | undefined): number {
  if (limit === undefined) return 200;
  if (!Number.isFinite(limit) || limit < 1 || !Number.isInteger(limit))
    throw new TrainError('bad_request', 'limit must be a positive integer');
  return Math.min(limit, 1000);
}

function memberTotal(size: number | undefined): number | undefined {
  return typeof size === 'number' && Number.isInteger(size) && size >= 0 ? size : undefined;
}

function capability(total: number | undefined, fetched: number, returned: number): MemberCapability {
  const complete = total !== undefined && total === fetched && returned === total;
  const reason = returned < fetched ? 'Member list was limited; increase limit up to 1000'
    : total === undefined ? 'WhatsApp did not report a total member count'
      : total !== fetched ? 'WhatsApp returned a partial member list' : undefined;
  return { supported: true, complete, ...(total === undefined ? {} : { total }), ...(reason ? { reason } : {}) };
}

export async function listMembers(
  jid: string,
  fetchGroup: (jid: string) => Promise<GroupMetadata>,
  names: NameBook,
  limit?: number,
): Promise<MemberList> {
  const cap = memberLimit(limit);
  if (!isGroupJid(jid)) return {
    members: [],
    capability: { supported: false, complete: false, reason: 'WhatsApp member lookup requires a group line (@g.us)' },
  };
  const group = await fetchGroup(jid);
  const participants = [...new Map(group.participants.map((p) => [p.id, p])).values()];
  const members = participants.slice(0, cap).map((p) => memberOf(p, names));
  return {
    members,
    capability: capability(memberTotal(group.size), participants.length, members.length),
  };
}
