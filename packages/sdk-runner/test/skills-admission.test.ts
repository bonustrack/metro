import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Runner, type OpenSession } from '../src/runner.js';
import { SessionStore } from '../src/session-store.js';
import { SkillsRefresh } from '../src/skills.js';
import { skillFixture, stageSkill, until } from './skills-helper.js';

test('one activation gate holds chat, call, scheduled and worker-report input until reload completes', async () => {
  const f = skillFixture();
  stageSkill(f.root);
  const skills = new SkillsRefresh(f.root, f.claude);
  let finish: (() => void) | undefined;
  let input: AsyncIterator<SDKUserMessage>;
  const delivered: SDKUserMessage[] = [];
  const events = async function* (): AsyncGenerator<SDKMessage> {
    for (;;) {
      const next = await input.next();
      if (next.done) return;
      delivered.push(next.value);
      yield { type: 'result', subtype: 'success', user_message_uuids: [next.value.uuid] } as unknown as SDKMessage;
    }
  };
  const open: OpenSession = (params) => {
    input = params.prompt[Symbol.asyncIterator]();
    return { [Symbol.asyncIterator]: events, applyFlagSettings: async () => undefined, reloadSkills: () => new Promise<void>((resolve) => { finish = resolve; }), close: () => undefined } as ReturnType<OpenSession>;
  };
  const runner = new Runner({ store: new SessionStore(join(f.dir, 'session.json'), f.claude, f.dir), readOnly: () => true, skills, open });
  runner.start({});
  const running = runner.run();
  try {
    runner.inbox.push('chat', 'chat input');
    runner.inbox.push('call', 'call input');
    runner.inbox.automation('scheduled input', randomUUID(), Date.now());
    runner.inbox.push('note', 'worker report');
    await Bun.sleep(30);
    expect(delivered).toEqual([]);
    expect(skills.busy).toBe(true);
    finish?.();
    await until(() => delivered.length === 4);
    expect(delivered.map((message) => message.message.content).sort()).toEqual(['call input', 'chat input', 'scheduled input', 'worker report']);
    expect(delivered.find((message) => message.message.content === 'scheduled input')?.origin).toEqual({ kind: 'task-notification', subkind: 'scheduled-trigger' });
  } finally { runner.close(); await running; rmSync(f.dir, { recursive: true, force: true }); }
});
