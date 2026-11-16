import { isIdentitySubject, type IdentityProvider } from '../db/identities.js';
import { listInvitations, listOrganizations, listUsers, organizationMemberships, PROVIDERS, userIdentities, type WorkosConfig, type WorkosIdentity, type WorkosUser } from '../auth/workos.js';

const BATCH = 5;
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const MSA_OID_PREFIX = '00000000-0000-0000-';
const CID_RE = /^[0-9a-f]{16}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SnapshotIdentity {
  user: string;
  provider: IdentityProvider;
  subject: string;
}

export interface Snapshot {
  organizations: { id: string; name: string | null }[];
  users: WorkosUser[];
  memberships: { organization: string; user: string; role: string }[];
  invitations: { organization: string; email: string; role: string | null }[];
  identities: SnapshotIdentity[];
  otherSignIns: { user: string; provider: string }[];
  unmapped: { user: string; provider: string; idpId: string }[];
  unverified: { user: string; email: string }[];
}

export function microsoftSubject(idpId: string): string | null {
  const id = idpId.toLowerCase();
  if (CID_RE.test(id)) return `${MSA_TENANT}:${MSA_OID_PREFIX}${id.slice(0, 4)}-${id.slice(4)}`;
  if (GUID_RE.test(id) && id.startsWith(MSA_OID_PREFIX)) return `${MSA_TENANT}:${id}`;
  return null;
}

function subjectOf(provider: IdentityProvider, idpId: string): string | null {
  if (provider === 'microsoft') return microsoftSubject(idpId);
  return isIdentitySubject('google', idpId) ? idpId : null;
}

const KNOWN: Record<string, IdentityProvider> = { [PROVIDERS.google]: 'google', [PROVIDERS.microsoft]: 'microsoft' };

function sortIdentities(user: string, found: WorkosIdentity[], into: Snapshot): void {
  for (const identity of found) {
    const provider = KNOWN[identity.provider];
    if (provider === undefined) {
      into.otherSignIns.push({ user, provider: identity.provider });
      continue;
    }
    const subject = subjectOf(provider, identity.idpId);
    if (subject === null) into.unmapped.push({ user, provider: identity.provider, idpId: identity.idpId });
    else into.identities.push({ user, provider, subject });
  }
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(...(await Promise.all(items.slice(i, i + BATCH).map(run))));
  return out;
}

export async function readWorkos(cfg: WorkosConfig): Promise<Snapshot> {
  const [organizations, listed] = await Promise.all([listOrganizations(cfg), listUsers(cfg)]);
  const unverified = listed.flatMap((u) => (u.email === null || u.emailVerified ? [] : [{ user: u.id, email: u.email }]));
  const users = listed.map((u) => (u.emailVerified ? u : { ...u, email: null }));
  const snapshot: Snapshot = { organizations: organizations.map((o) => ({ id: o.id, name: o.name })), users, memberships: [], invitations: [], identities: [], otherSignIns: [], unmapped: [], unverified };
  const people = await inBatches(organizations, async (o) => ({ id: o.id, members: await organizationMemberships(cfg, o.id), invited: await listInvitations(cfg, o.id) }));
  for (const { id, members, invited } of people) {
    for (const m of members) snapshot.memberships.push({ organization: id, user: m.userId, role: m.role });
    for (const i of invited) snapshot.invitations.push({ organization: id, email: i.email, role: i.role });
  }
  const found = await inBatches(users, async (u) => ({ user: u.id, identities: await userIdentities(cfg, u.id) }));
  for (const { user, identities } of found) sortIdentities(user, identities, snapshot);
  return snapshot;
}
