import { expect, spyOn, test } from 'bun:test';
import { fetchClaudeSkills } from '../src/api/claude.js';
import { changeSkillSource, githubSkillSource } from '../src/api/skill-source.js';
import { clearAccount } from '../src/auth/account.js';
import { applyPayload, gatherPayload } from '../src/export/transfer.js';
import { installTestAccount } from './account-fixture.js';

test('older daemons have no source capability and remote rows cannot become editable', async () => {
  installTestAccount();
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json({ skills: [{ id: 'github:team', name: 'team', path: '/managed/team/SKILL.md', editable: true, managed: true }] })));
  try {
    const listing = await fetchClaudeSkills();
    expect(listing.skillSource).toBeUndefined();
    expect(listing.skills[0]?.editable).toBe(false);
    expect(listing.skills[0]?.managed).toBe(true);
    expect(githubSkillSource({})).toBeUndefined();
  } finally { fetch.mockRestore(); clearAccount(); }
});

test('source parsing retains revision status but drops unexpected credentials', () => {
  const source = { repository: 'example/skills', ref: 'main', folder: 'skills', token: 'private' };
  const revision = { ...source, commit: 'a'.repeat(40), repositoryId: 42 };
  const view = githubSkillSource({ supported: true, source, loaded: revision, prepared: { generation: 'id', source: revision, skillCount: 2 }, pending: true, activation: { generation: 'old', shadowed: ['local', 123], token: 'private' } });
  expect(view?.pending).toBe(true);
  expect(view?.loaded?.commit).toBe('a'.repeat(40));
  expect(view?.activation.shadowed).toEqual(['local']);
  expect(JSON.stringify(view)).not.toContain('private');
});

test('exports omit managed skills and source configuration', async () => {
  installTestAccount();
  const local = { id: 'local', name: 'local', editable: true, text: 'local body' };
  const fetch = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ skills: [local, { id: 'github:remote', name: 'remote', managed: true }], skillSource: { supported: true, source: { repository: 'example/private', ref: 'main', folder: 'skills', token: 'secret' } } }))
    .mockResolvedValueOnce(Response.json(local));
  try {
    const gathered = await gatherPayload({ id: 'agent', name: 'Agent' }, new Set(['skills']), 'now');
    expect(gathered.payload.skills).toEqual([{ place: 'This machine', name: 'local', text: 'local body' }]);
    expect(JSON.stringify(gathered)).not.toMatch(/secret|example\/private|remote/);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { fetch.mockRestore(); clearAccount(); }
});

for (const mode of ['append', 'overwrite'] as const) test(`restore ${mode} creates a local skill beside a managed name`, async () => {
  installTestAccount();
  const local = { id: 'local', name: 'team' };
  const fetch = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ skills: [{ id: 'github:team', name: 'team', managed: true }] }))
    .mockResolvedValueOnce(Response.json(local))
    .mockResolvedValueOnce(Response.json(local));
  try {
    const result = await applyPayload({ version: 1, exportedAt: 'now', agent: { name: 'Agent' }, skills: [{ place: 'This machine', name: 'team', text: 'local body' }] }, new Set(['skills']), mode, { id: 'agent', name: 'Agent' });
    expect(result.skills).toBe(1);
    expect(result.skipped).toBe(0);
    expect(fetch.mock.calls.map((args) => args[1]?.method)).toEqual(['GET', 'POST', 'PUT']);
    expect(String(fetch.mock.calls[2]?.[0])).toEndWith('/api/claude/skills/local');
  } finally { fetch.mockRestore(); clearAccount(); }
});

test('source writes use the selected box and keep the token out of the URL', async () => {
  installTestAccount();
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json({})));
  try {
    await changeSkillSource('PUT', { repository: 'example/skills', ref: 'main', folder: 'skills', token: 'private' });
    await changeSkillSource('POST');
    await changeSkillSource('DELETE');
    expect(fetch.mock.calls.map((args) => args[1]?.method)).toEqual(['PUT', 'POST', 'DELETE']);
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain('private');
    expect(fetch.mock.calls[0]?.[1]?.body).toContain('private');
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
  } finally { fetch.mockRestore(); clearAccount(); }
});
