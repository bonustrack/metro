import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillGeneration, skillRelease, skillSourceRoot, type SkillActivation, type SkillGeneration } from '@metro-labs/core/skill-source';

export function skillFixture(): { dir: string; claude: string; root: string } {
  const dir = mkdtempSync('/tmp/sdk-skills-');
  const claude = join(dir, 'claude');
  return { dir, claude, root: skillSourceRoot(claude) };
}

export function stageSkill(root: string, body = 'first', removed = false): SkillGeneration {
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
  const text = `---\nname: team-example\ndescription: Team skill\n---\n${body}\n`;
  const generation = skillGeneration({
    id: hash(randomUUID()), createdAt: new Date().toISOString(),
    source: removed ? null : { repository: 'example/skills', repositoryId: 42, ref: 'main', folder: 'skills', commit: 'a'.repeat(40) },
    skills: removed ? [] : [{ name: 'team-example', description: 'Team skill' }],
    files: removed ? [] : [{ path: 'team-example/SKILL.md', size: Buffer.byteLength(text), sha256: hash(text) }],
  });
  const release = skillRelease(root, generation.id);
  mkdirSync(join(release, removed ? 'skills' : 'skills/team-example'), { recursive: true });
  if (!removed) writeFileSync(join(release, 'skills/team-example/SKILL.md'), text);
  writeFileSync(join(release, 'manifest.json'), JSON.stringify(generation));
  writeFileSync(join(root, 'pending.json'), JSON.stringify(generation));
  return generation;
}

export const activation = (root: string): SkillActivation => JSON.parse(readFileSync(join(root, 'status.json'), 'utf8')) as SkillActivation;
export async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 1500;
  while (!check()) { if (Date.now() > end) throw new Error('Skills fixture timed out.'); await Bun.sleep(5); }
}
