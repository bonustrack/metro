import { call } from './client';
import { isRecord } from './accounts';
import { daemonBase } from '../auth/session';

export interface Collection {
  id: string;
  name: string;
  connectorIds: string[];
}

export interface CollectionCode {
  code: string;
  expiresAt: number;
  collection: string;
}

const collectionsUrl = (): string => `${daemonBase()}/api/collections`;

function toCollection(value: unknown): Collection {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    throw new Error('Metro returned an unexpected response.');
  const ids = value.connectorIds;
  return {
    id: value.id,
    name: value.name,
    connectorIds: Array.isArray(ids)
      ? ids.filter((v): v is string => typeof v === 'string')
      : [],
  };
}

export async function fetchCollections(
  token: string,
  project: string,
): Promise<Collection[]> {
  const body = await call(token, {
    base: collectionsUrl(),
    method: 'GET',
    path: `?project=${project}`,
  });
  if (!isRecord(body) || !Array.isArray(body.collections))
    throw new Error('Metro returned an unexpected response.');
  return body.collections.map(toCollection);
}

export async function fetchCollection(
  token: string,
  id: string,
): Promise<Collection> {
  return toCollection(await call(token, { base: collectionsUrl(), method: 'GET', path: `/${id}` }));
}

const json = (body: unknown): { headers: Record<string, string>; body: string } => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function createCollection(
  token: string,
  project: string,
  name: string,
): Promise<Collection> {
  return toCollection(
    await call(token, {
      base: collectionsUrl(),
      method: 'POST',
      path: `?project=${project}`,
      ...json({ name }),
    }),
  );
}

export async function renameCollection(
  token: string,
  id: string,
  name: string,
): Promise<Collection> {
  return toCollection(
    await call(token, {
      base: collectionsUrl(),
      method: 'POST',
      path: `/${id}/rename`,
      ...json({ name }),
    }),
  );
}

export async function deleteCollection(token: string, id: string): Promise<void> {
  await call(token, { base: collectionsUrl(), method: 'DELETE', path: `/${id}` });
}

export async function addToCollection(
  token: string,
  id: string,
  connectorId: string,
): Promise<Collection> {
  return toCollection(
    await call(token, {
      base: collectionsUrl(),
      method: 'POST',
      path: `/${id}/items`,
      ...json({ connectorId }),
    }),
  );
}

export async function removeFromCollection(
  token: string,
  id: string,
  connectorId: string,
): Promise<Collection> {
  return toCollection(
    await call(token, {
      base: collectionsUrl(),
      method: 'DELETE',
      path: `/${id}/items/${connectorId}`,
    }),
  );
}

export async function mintCollectionCode(
  token: string,
  id: string,
): Promise<CollectionCode> {
  const body = await call(token, {
    base: collectionsUrl(),
    method: 'POST',
    path: `/${id}/code`,
  });
  if (
    !isRecord(body) ||
    typeof body.code !== 'string' ||
    typeof body.collection !== 'string'
  )
    throw new Error('Metro returned an unexpected response.');
  return {
    code: body.code,
    collection: body.collection,
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
  };
}
