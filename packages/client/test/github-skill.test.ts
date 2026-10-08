import { expect, spyOn, test } from 'bun:test';
import { fetchClaudeSkill, fetchClaudeSkills } from '../src/api/claude.js';
import { githubCommitUrl, githubSkillOrigin, githubSkillUrl } from '../src/api/github-skill.js';
import { clearAccount } from '../src/auth/account.js';
import { installTestAccount } from './account-fixture.js';

const origin = { repository: 'example/skills.repo', commit: 'a'.repeat(40), folder: 'team/.skills' };
const managed = { id: 'github:team-example', name: 'team-example', managed: true, github: origin };

test('skill links point to the immutable file, including nested and root folders', () => {
  expect(githubSkillUrl(managed)).toBe(`https://github.com/example/skills.repo/blob/${origin.commit}/team/.skills/team-example/SKILL.md`);
  expect(githubSkillUrl({ ...managed, github: { ...origin, folder: '' } })).toBe(`https://github.com/example/skills.repo/blob/${origin.commit}/team-example/SKILL.md`);
  expect(githubCommitUrl(origin)).toBe(`https://github.com/example/skills.repo/commit/${origin.commit}`);
  expect(githubSkillUrl({ ...managed, managed: false })).toBeNull();
  expect(githubSkillUrl({ name: 'team-example', managed: true })).toBeNull();
  expect(githubSkillUrl({ ...managed, name: '../local' })).toBeNull();
});

test.each([
  { repository: 'https://evil.invalid/example/skills' }, { repository: 'example/skills?token=secret' },
  { repository: 'example@evil.invalid/skills' }, { repository: 'example/../skills' },
  { commit: 'main' }, { commit: 'a'.repeat(39) }, { commit: `../${'a'.repeat(40)}` },
  { folder: '../skills' }, { folder: '/skills' }, { folder: 'team//skills' },
  { folder: 'team/./skills' }, { folder: 'team\\skills' }, { folder: '%2e%2e/skills' },
  { folder: 'team/skills#fragment' }, { folder: 'team/skills with spaces' }, { folder: 'a/'.repeat(7) },
])('invalid origin has no navigable GitHub URL: %j', (part) => {
  const github = { ...origin, ...part };
  expect(githubSkillOrigin(github)).toBeNull();
  expect(githubCommitUrl(github)).toBeNull();
  expect(githubSkillUrl({ ...managed, github })).toBeNull();
});

test('list and detail whitelist loaded row provenance, never current or staged sources or local overrides', async () => {
  installTestAccount();
  const raw = { ...managed, shadowed: true, github: { ...origin, token: 'secret' } };
  const replacement = { repository: 'new/skills', ref: 'pending/ref', folder: 'different', commit: 'b'.repeat(40), repositoryId: 1 };
  const fetch = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ skills: [raw, { ...raw, id: 'user:team-example', managed: false }, { ...raw, github: { ...origin, commit: 'main' } }], skillSource: { supported: true, source: replacement, prepared: { generation: 'next', source: replacement } } }))
    .mockResolvedValueOnce(Response.json({ ...raw, text: 'Synthetic instructions' }));
  try {
    const listing = await fetchClaudeSkills();
    const detail = await fetchClaudeSkill(managed.id);
    expect(listing.skills[0]?.github).toEqual(origin);
    expect(listing.skills[0]?.shadowed).toBe(true);
    expect(listing.skills[1]?.github).toBeUndefined();
    expect(listing.skills[2]?.github).toBeUndefined();
    expect(detail.github).toEqual(origin);
    expect(githubSkillUrl(detail)).toContain(`/blob/${origin.commit}/`);
    expect(JSON.stringify([listing, detail])).not.toContain('secret');
  } finally { fetch.mockRestore(); clearAccount(); }
});
