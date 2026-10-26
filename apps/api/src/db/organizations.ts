import { eq, inArray } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { getDb, type Database } from './client.js';
import { isUniqueViolation } from '@metro-labs/connectors/db/errors';
import { organizations } from './schema.js';
import { storedAvatar, type OrganizationAvatars } from '../avatar.js';
import { parseSlug, slugify, withSuffix, type SlugStore } from '../slug.js';

const TRIES = 20;

type OrganizationStore = SlugStore & OrganizationAvatars;

export function organizationStore(db: () => Database): OrganizationStore {
  async function current(organization: string): Promise<string | null> {
    const rows = await db().select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, organization)).limit(1);
    return rows[0]?.slug ?? null;
  }

  async function insert(organization: string, slug: string): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await db().insert(organizations).values({ id: organization, slug, createdAt: now, updatedAt: now });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async function ensure(organization: string, name: string | null): Promise<string> {
    const held = await current(organization);
    if (held !== null) return held;
    const base = slugify(name ?? organization);
    for (let n = 1; n <= TRIES; n += 1) {
      const candidate = n === 1 ? base : withSuffix(base, n);
      if (await insert(organization, candidate)) return candidate;
      const raced = await current(organization);
      if (raced !== null) return raced;
    }
    throw new ApiError('could not find a free slug for that organization', 409);
  }

  async function set(organization: string, raw: string): Promise<string> {
    const slug = parseSlug(raw);
    await ensure(organization, null);
    try {
      const rows = await db().update(organizations).set({ slug, updatedAt: new Date().toISOString() }).where(eq(organizations.id, organization)).returning({ slug: organizations.slug });
      const row = rows[0];
      if (row === undefined) throw new ApiError('no such organization', 404);
      return row.slug;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('that slug is taken', 409);
      throw err;
    }
  }

  async function find(slug: string): Promise<string | null> {
    const rows = await db().select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug.toLowerCase())).limit(1);
    return rows[0]?.id ?? null;
  }

  async function avatars(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db().select({ id: organizations.id, avatar: organizations.avatar }).from(organizations).where(inArray(organizations.id, ids));
    return new Map(rows.flatMap((r) => {
      const avatar = storedAvatar(r.avatar);
      return avatar === null ? [] : [[r.id, avatar] as const];
    }));
  }

  async function setAvatar(organization: string, avatar: string | null): Promise<void> {
    const rows = await db().update(organizations).set({ avatar, updatedAt: new Date().toISOString() }).where(eq(organizations.id, organization)).returning({ id: organizations.id });
    if (rows.length === 0) throw new ApiError('no such organization', 404);
  }

  return { ensure, set, find, avatars, setAvatar };
}

export const dbOrganizations = organizationStore(getDb);
