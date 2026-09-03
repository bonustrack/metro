import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  handleProjectApiRequest,
  type ProjectApiDeps,
} from '../src/daemon/project-api.js';
import { signAgentToken, signSession } from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';
import type { Member, Project } from '../src/db/projects.js';

const SECRET = 'a-test-session-secret';
const ADA = 'ada@lovelace.dev';
const BOB = 'bob@example.com';

interface Row extends Project {
  email: string;
  members: Member[];
}

let rows: Row[] = [];

const seed = (): Row[] => [
  {
    id: 'prj00000001',
    email: ADA,
    name: 'Personal',
    isDefault: true,
    owner: true,
    role: 'admin',
    members: [
      { id: 'mem00000001', email: ADA, role: 'admin', owner: true },
      { id: 'mem00000002', email: BOB, role: 'member', owner: false },
    ],
  },
  {
    id: 'prj00000002',
    email: ADA,
    name: 'work',
    isDefault: false,
    owner: true,
    role: 'admin',
    members: [{ id: 'mem00000003', email: ADA, role: 'admin', owner: true }],
  },
  {
    id: 'prj00000009',
    email: BOB,
    name: 'theirs',
    isDefault: true,
    owner: true,
    role: 'admin',
    members: [{ id: 'mem00000009', email: BOB, role: 'admin', owner: true }],
  },
];

const missing = (): ApiError => new ApiError('no such project', 404);

function mine(email: string, id: string): Row {
  const row = rows.find((r) => r.id === id && r.email === email);
  if (row === undefined) throw missing();
  return row;
}

const strip = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  isDefault: r.isDefault,
  owner: r.owner,
  role: r.role,
});

const deps: ProjectApiDeps = {
  listProjects: (email) =>
    Promise.resolve(rows.filter((r) => r.email === email).map(strip)),
  createProject: (email, name) => {
    const row: Row = {
      id: `prj0000001${String(rows.length)}`,
      email,
      name: String(name),
      isDefault: false,
      owner: true,
      role: 'admin',
      members: [],
    };
    rows.push(row);
    return Promise.resolve(strip(row));
  },
  renameProject: (email, id, name) => {
    const row = mine(email, id);
    row.name = String(name);
    return Promise.resolve(strip(row));
  },
  deleteProject: (email, id) => {
    const row = mine(email, id);
    if (row.isDefault)
      throw new ApiError('your default project cannot be deleted', 403);
    rows = rows.filter((r) => r.id !== id);
    return Promise.resolve({ id: row.id, name: row.name });
  },
  listMembers: (email, id) => Promise.resolve(mine(email, id).members),
  addMember: (email, id, invited, role) => {
    const row = mine(email, id);
    if (role !== 'admin' && role !== 'member')
      throw new ApiError("a role is 'admin' or 'member'", 400);
    row.members.push({
      id: `mem0000010${String(row.members.length)}`,
      email: String(invited),
      role,
      owner: false,
    });
    return Promise.resolve(row.members);
  },
  setMemberRole: (email, id, memberId, role) => {
    const row = mine(email, id);
    const member = row.members.find((m) => m.id === memberId);
    if (member === undefined) throw new ApiError('no such member', 404);
    if (member.owner) throw new ApiError('the owner is always an admin', 403);
    member.role = role === 'admin' ? 'admin' : 'member';
    return Promise.resolve(row.members);
  },
  removeMember: (email, id, memberId) => {
    const row = mine(email, id);
    const member = row.members.find((m) => m.id === memberId);
    if (member === undefined) throw new ApiError('no such member', 404);
    if (member.owner)
      throw new ApiError('the owner cannot be removed', 403);
    row.members = row.members.filter((m) => m.id !== memberId);
    return Promise.resolve(row.members);
  },
};

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  server = createServer((req, res) => {
    if (handleProjectApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(() => {
  rows = seed();
});

afterAll(() => {
  server.close();
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
});

const session = (email: string): string =>
  signSession({ email, agentIds: [] }, SECRET);

const call = (
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('a project is what everything else hangs off', () => {
  test('the list shows only the projects you belong to', async () => {
    const res = await call('GET', '/api/projects', session(ADA));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Project[] };
    expect(body.projects.map((p) => p.name)).toEqual(['Personal', 'work']);
  });

  test('every route needs a signed-in session', async () => {
    for (const [method, path] of [
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['DELETE', '/api/projects/prj00000001'],
      ['POST', '/api/projects/prj00000001/rename'],
      ['GET', '/api/projects/prj00000001/members'],
    ])
      expect((await call(method ?? '', path ?? '')).status).toBe(401);
  });

  test('an agent token is not a session here either', async () => {
    const cli = signAgentToken({ email: ADA, agentId: 'agent000001' }, SECRET);
    expect((await call('GET', '/api/projects', cli)).status).toBe(401);
  });

  test("somebody else's project is the same 404 as one that never existed", async () => {
    for (const id of ['prj00000009', 'prj00099999'])
      expect(
        (await call('POST', `/api/projects/${id}/rename`, session(ADA), { name: 'x' }))
          .status,
      ).toBe(404);
  });
});

describe('creating, renaming and deleting', () => {
  test('a create comes back as an owned admin project', async () => {
    const res = await call('POST', '/api/projects', session(ADA), { name: 'side' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      name: 'side',
      owner: true,
      role: 'admin',
      isDefault: false,
    });
  });

  test('rename answers with the new name', async () => {
    const res = await call('POST', '/api/projects/prj00000002/rename', session(ADA), {
      name: 'day job',
    });
    expect(await res.json()).toMatchObject({ name: 'day job' });
  });

  test('the default project cannot be deleted', async () => {
    expect(
      (await call('DELETE', '/api/projects/prj00000001', session(ADA))).status,
    ).toBe(403);
  });

  test('a non-default project can be', async () => {
    const res = await call('DELETE', '/api/projects/prj00000002', session(ADA));
    expect(await res.json()).toEqual({ id: 'prj00000002', name: 'work' });
  });
});

describe('members', () => {
  test('the list carries the owner flag and each role', async () => {
    const res = await call('GET', '/api/projects/prj00000001/members', session(ADA));
    expect(await res.json()).toEqual({
      members: [
        { id: 'mem00000001', email: ADA, role: 'admin', owner: true },
        { id: 'mem00000002', email: BOB, role: 'member', owner: false },
      ],
    });
  });

  test('a member can be added, promoted and removed', async () => {
    const added = (await (
      await call('POST', '/api/projects/prj00000002/members', session(ADA), {
        email: 'carol@example.com',
        role: 'member',
      })
    ).json()) as { members: Member[] };
    const carol = added.members.find((m) => m.email === 'carol@example.com');
    expect(carol?.role).toBe('member');
    const promoted = (await (
      await call(
        'POST',
        `/api/projects/prj00000002/members/${carol?.id ?? ''}`,
        session(ADA),
        { role: 'admin' },
      )
    ).json()) as { members: Member[] };
    expect(promoted.members.find((m) => m.email === 'carol@example.com')?.role).toBe(
      'admin',
    );
    const left = (await (
      await call(
        'DELETE',
        `/api/projects/prj00000002/members/${carol?.id ?? ''}`,
        session(ADA),
      )
    ).json()) as { members: Member[] };
    expect(left.members.map((m) => m.email)).toEqual([ADA]);
  });

  test('the owner can be neither demoted nor removed', async () => {
    expect(
      (await call(
        'POST',
        '/api/projects/prj00000001/members/mem00000001',
        session(ADA),
        { role: 'member' },
      )).status,
    ).toBe(403);
    expect(
      (await call(
        'DELETE',
        '/api/projects/prj00000001/members/mem00000001',
        session(ADA),
      )).status,
    ).toBe(403);
  });

  test('a bad role is refused', async () => {
    expect(
      (await call('POST', '/api/projects/prj00000002/members', session(ADA), {
        email: 'x@y.z',
        role: 'root',
      })).status,
    ).toBe(400);
  });
});

describe('the shape of the route itself', () => {
  test('a wrong method is 405 and an unknown sub-route is 404', async () => {
    expect((await call('PUT', '/api/projects', session(ADA))).status).toBe(405);
    expect(
      (await call('GET', '/api/projects/prj00000001/nope', session(ADA))).status,
    ).toBe(404);
    expect((await call('GET', '/api/projects/not-an-id', session(ADA))).status).toBe(
      404,
    );
  });
});
