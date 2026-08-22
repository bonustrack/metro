import { isUniqueViolation } from './users.js';
import { projectIdOrThrow } from './projects.js';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from './client.js';
import { newId } from './ids.js';
import { ConnectorError, connectorName } from './connector-config.js';
import { collectionItems, collections, connectors } from './schema.js';

export interface ConnectorCollectionRow {
  id: string;
  name: string;
  connectorIds: string[];
}

interface CollectionRow {
  id: string;
  projectId: string;
  name: string;
}

const missing = (): ConnectorError =>
  new ConnectorError('no such collection', 404);

const duplicate = (name: string): ConnectorError =>
  new ConnectorError(`you already have a collection named '${name}'`, 409);

const nameClash = (name: string, collection: string): ConnectorError =>
  new ConnectorError(
    `the collection '${collection}' already has a connector named '${name}'`,
    409,
  );

async function collidingCollection(
  collectionIds: string[],
  name: string,
  exceptConnectorId: string,
): Promise<string | null> {
  if (collectionIds.length === 0) return null;
  const rows = await getDb()
    .select({ collection: collections.name })
    .from(collectionItems)
    .innerJoin(connectors, eq(connectors.id, collectionItems.connectorId))
    .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
    .where(
      and(
        inArray(collectionItems.collectionId, collectionIds),
        eq(connectors.name, name),
        ne(connectors.id, exceptConnectorId),
      ),
    )
    .limit(1);
  return rows[0]?.collection ?? null;
}

export async function assertRenameFreeOfClash(
  connectorId: string,
  name: string,
): Promise<void> {
  const rows = await getDb()
    .select({ collectionId: collectionItems.collectionId })
    .from(collectionItems)
    .where(eq(collectionItems.connectorId, connectorId));
  const clash = await collidingCollection(
    rows.map((r) => r.collectionId),
    name,
    connectorId,
  );
  if (clash !== null) throw nameClash(name, clash);
}

async function ownedCollectionOrThrow(
  email: string,
  id: string,
): Promise<CollectionRow> {
  const rows = await getDb()
    .select()
    .from(collections)
    .where(eq(collections.id, id));
  const row = rows[0];
  if (row === undefined) throw missing();
  try {
    await projectIdOrThrow(email, row.projectId);
  } catch {
    throw missing();
  }
  return row;
}

async function itemsOf(collectionId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ connectorId: collectionItems.connectorId })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, collectionId))
    .orderBy(asc(collectionItems.id));
  return rows.map((r) => r.connectorId);
}

async function withItems(row: CollectionRow): Promise<ConnectorCollectionRow> {
  return { id: row.id, name: row.name, connectorIds: await itemsOf(row.id) };
}

export async function listCollectionsForEmail(
  email: string,
  project: string,
): Promise<ConnectorCollectionRow[]> {
  const projectId = await projectIdOrThrow(email, project);
  const rows = await getDb()
    .select()
    .from(collections)
    .where(eq(collections.projectId, projectId))
    .orderBy(asc(collections.id));
  return Promise.all(rows.map(withItems));
}

export async function getCollectionForEmail(
  email: string,
  id: string,
): Promise<ConnectorCollectionRow> {
  return withItems(await ownedCollectionOrThrow(email, id));
}

export async function createCollectionForEmail(
  email: string,
  project: string,
  raw: string,
): Promise<ConnectorCollectionRow> {
  const name = connectorName(raw);
  const projectId = await projectIdOrThrow(email, project);
  try {
    const rows = await getDb()
      .insert(collections)
      .values({ id: newId(), projectId, name })
      .returning();
    const row = rows[0];
    if (row === undefined)
      throw new ConnectorError('collection insert returned no row', 500);
    return { id: row.id, name: row.name, connectorIds: [] };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw duplicate(name);
  }
}

export async function renameCollectionForEmail(
  email: string,
  id: string,
  raw: string,
): Promise<ConnectorCollectionRow> {
  const name = connectorName(raw);
  const row = await ownedCollectionOrThrow(email, id);
  try {
    await getDb()
      .update(collections)
      .set({ name })
      .where(eq(collections.id, row.id));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw duplicate(name);
  }
  return withItems({ ...row, name });
}

export async function deleteCollectionForEmail(
  email: string,
  id: string,
): Promise<{ id: string; name: string }> {
  const row = await ownedCollectionOrThrow(email, id);
  await getDb().delete(collections).where(eq(collections.id, row.id));
  return { id: row.id, name: row.name };
}

async function connectorNameIn(
  projectId: string,
  connectorId: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ name: connectors.name })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.projectId, projectId)));
  return rows[0]?.name ?? null;
}

export async function addToCollectionForEmail(
  email: string,
  id: string,
  connectorId: string,
): Promise<ConnectorCollectionRow> {
  const row = await ownedCollectionOrThrow(email, id);
  const name = await connectorNameIn(row.projectId, connectorId);
  if (name === null) throw new ConnectorError('no such connector', 404);
  const clash = await collidingCollection([row.id], name, connectorId);
  if (clash !== null) throw nameClash(name, clash);
  try {
    await getDb()
      .insert(collectionItems)
      .values({ id: newId(), collectionId: row.id, connectorId });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  return withItems(row);
}

export async function removeFromCollectionForEmail(
  email: string,
  id: string,
  connectorId: string,
): Promise<ConnectorCollectionRow> {
  const row = await ownedCollectionOrThrow(email, id);
  await getDb()
    .delete(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, row.id),
        eq(collectionItems.connectorId, connectorId),
      ),
    );
  return withItems(row);
}
