import type { PlannedMember, SyncPlan } from './plan.js';

const shown = (value: string | null): string => (value === null ? '(none)' : `"${value}"`);

const who = (m: { user: string; email: string | null }): string => `${m.email ?? '(no email)'} (${m.user})`;

const memberLine = (sign: string, m: PlannedMember, tail: string): string => `${sign} membership ${who(m)} in ${m.organization}: ${tail}`;

function totals(plan: SyncPlan): string[] {
  const c = plan.counts;
  const { organizations: o, users: u, memberships: m, identities: i } = plan;
  return [
    `WorkOS: ${String(c.organizations)} organizations, ${String(c.users)} users, ${String(c.memberships)} active memberships, ${String(c.invitations)} pending invitations, ${String(c.google)} Google and ${String(c.microsoft)} Microsoft sign-ins.`,
    `Organizations: ${String(o.added.length)} added, ${String(o.renamed.length)} renamed, ${String(o.onlyInMetro.length)} only in Metro.`,
    `Users: ${String(u.added.length)} added, ${String(u.changed.length)} changed, ${String(u.emailsMoved.length)} emails moved, ${String(u.invited.length)} invited people added.`,
    `Memberships: ${String(m.added.length)} added, ${String(m.changed.length)} role changes, ${String(m.removed.length)} removed.`,
    `Identities: ${String(i.added.length)} added, ${String(i.moved.length)} moved.`,
  ];
}

function differences(plan: SyncPlan): string[] {
  return [
    ...plan.organizations.added.map((o) => `+ organization ${o.id} ${shown(o.name)} with slug ${o.slug}`),
    ...plan.organizations.renamed.map((o) => `~ organization ${o.id} name ${shown(o.from)} -> ${shown(o.to)}`),
    ...plan.users.added.map((u) => `+ user ${who({ user: u.id, email: u.email })}`),
    ...plan.users.changed.map((c) => `~ user ${c.user.id}: ${c.changes.map((f) => `${f.field} ${shown(f.from)} -> ${shown(f.to)}`).join(', ')}`),
    ...plan.users.emailsMoved.map((m) => `~ email ${m.email} moves from ${m.from} to ${m.to}`),
    ...plan.users.invited.map((i) => `+ invited person ${i.email} (${i.id})`),
    ...plan.memberships.added.map((m) => memberLine('+', m, `${m.role}${m.invited ? ', from a pending invitation' : ''}`)),
    ...plan.memberships.changed.map((m) => memberLine('~', m, `${m.from} -> ${m.role}`)),
    ...plan.memberships.removed.map((m) => memberLine('-', m, `${m.role}, WorkOS no longer has it`)),
    ...plan.identities.added.map((i) => `+ ${i.provider} sign-in ${i.subject} for ${who(i)}`),
    ...plan.identities.moved.map((i) => `~ ${i.provider} sign-in ${i.subject} moves from ${i.from} to ${who(i)}`),
  ];
}

function outsiders(plan: SyncPlan): string[] {
  if (plan.outsiders.length === 0) return [];
  const github = plan.outsiders.filter((o) => o.signIn === 'github').length;
  const email = plan.outsiders.filter((o) => o.signIn === 'email').length;
  const other = plan.outsiders.length - github - email;
  return [
    `Neither Google nor Microsoft (${String(plan.outsiders.length)}: ${String(github)} GitHub, ${String(email)} email code only${other > 0 ? `, ${String(other)} other` : ''}). They will need Google, Microsoft or a login link:`,
    ...plan.outsiders.map((o) => `  ${who(o)}: ${o.signIn === 'email' ? 'email code only' : o.signIn}, member of ${String(o.organizations)} organizations`),
  ];
}

function warnings(plan: SyncPlan): string[] {
  const all = [...plan.organizations.onlyInMetro.map((id) => `organization ${id} is not in WorkOS: it keeps its row, and its memberships go`), ...plan.warnings];
  return all.length === 0 ? [] : ['Warnings:', ...all.map((w) => `  ${w}`)];
}

export function reportLines(plan: SyncPlan, applied: boolean): string[] {
  const changes = differences(plan);
  return [
    applied ? 'WorkOS export: written in one transaction.' : 'WorkOS export: dry run, nothing written. Run again with --apply to write.',
    ...totals(plan),
    ...(changes.length === 0 ? ['Metro already matches WorkOS.'] : changes),
    ...outsiders(plan),
    ...warnings(plan),
  ];
}
