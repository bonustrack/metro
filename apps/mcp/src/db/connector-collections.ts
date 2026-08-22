import { isUniqueViolation } from './users.js';
import { projectIdOrThrow } from './projects.js';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { newId } from './ids.js';
import { ConnectorError, connectorName } from './connector-config.js';
import { connectorCollectionItems, connectorCollections, connectors } from './schema.js';

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

async function ownedCollectionOrThrow(
  email: string,
  id: string,
): Promise<CollectionRow> {
  const rows = await getDb()
    .select()
    .from(connectorCollections)
    .where(eq(connectorCollections.id, id));
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
    .select({ connectorId: connectorCollectionItems.connectorId })
    .from(connectorCollectionItems)
    .where(eq(connectorCollectionItems.collectionId, collectionId))
    .orderBy(asc(connectorCollectionItems.id));
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
    .from(connectorCollections)
    .where(eq(connectorCollections.projectId, projectId))
    .orderBy(asc(connectorCollections.id));
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
      .insert(connectorCollections)
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
      .update(connectorCollections)
      .set({ name })
      .where(eq(connectorCollections.id, row.id));
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
  await getDb().delete(connectorCollections).where(eq(connectorCollections.id, row.id));
  return { id: row.id, name: row.name };
}

async function ownsConnector(
  projectId: string,
  connectorId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.projectId, projectId)));
  return rows.length > 0;
}

export async function addToCollectionForEmail(
  email: string,
  id: string,
  connectorId: string,
): Promise<ConnectorCollectionRow> {
  const row = await ownedCollectionOrThrow(email, id);
  if (!(await ownsConnector(row.projectId, connectorId)))
    throw new ConnectorError('no such connector', 404);
  try {
    await getDb()
      .insert(connectorCollectionItems)
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
    .delete(connectorCollectionItems)
    .where(
      and(
        eq(connectorCollectionItems.collectionId, row.id),
        eq(connectorCollectionItems.connectorId, connectorId),
      ),
    );
  return withItems(row);
}
