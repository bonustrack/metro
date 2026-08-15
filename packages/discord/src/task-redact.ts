export const CATEGORIES = [
  'review',
  'fix',
  'build',
  'check',
  'research',
  'deploy',
  'write',
  'chat',
  'sweep',
  'task',
] as const;

export type Category = (typeof CATEGORIES)[number];

const VERBS: [Category, string[]][] = [
  ['review', ['review', 'reviewing', 'reviewed', 'critique', 'assess', 'audit']],
  ['fix', ['fix', 'fixing', 'repair', 'drop', 'remove', 'patch', 'resolve', 'unbreak']],
  ['build', ['build', 'add', 'implement', 'create', 'make', 'wire', 'extend', 'rebase']],
  ['check', ['check', 'verify', 'confirm', 'test', 'probe', 'validate', 'prove', 'measure']],
  ['research', ['research', 'investigate', 'diagnose', 'find', 'explore', 'trace', 'settle', 'work']],
  ['deploy', ['deploy', 'publish', 'release', 'ship', 'republish', 'push', 'roll']],
  ['write', ['write', 'draft', 'document', 'note', 'record', 'summarise', 'summarize', 'report']],
  ['chat', ['post', 'reply', 'answer', 'tell', 'ask', 'message', 'ping', 'respond']],
  ['sweep', ['sweep', 'triage', 'tidy', 'clean', 'sort', 'chase', 'watch', 'poll']],
];

const LOOKUP = new Map<string, Category>();
for (const [category, verbs] of VERBS)
  for (const verb of verbs) LOOKUP.set(verb, category);

export function categorise(label: unknown): Category {
  if (typeof label !== 'string') return 'task';
  const first = label.trim().toLowerCase().split(/[^a-z]+/).find(Boolean);
  if (first === undefined) return 'task';
  return LOOKUP.get(first) ?? 'task';
}
