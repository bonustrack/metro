#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const given = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
const claudeDir = given(process.env.CLAUDE_CONFIG_DIR) ?? join(given(process.env.HOME) ?? homedir(), '.claude');
const SKILL = join(claudeDir, 'skills', 'metro-orchestrator', 'SKILL.md');
const FALLBACK = join(dirname(dirname(fileURLToPath(import.meta.url))), 'orchestrator.md');

const body = (text) => text.replace(/^---[\s\S]*?\n---\n/, '').trim();

function guidance() {
  for (const path of [SKILL, FALLBACK]) {
    if (!existsSync(path)) continue;
    try {
      const text = body(readFileSync(path, 'utf8'));
      if (text !== '') return text;
    } catch {
      continue;
    }
  }
  return '';
}

const text = guidance();
if (text !== '')
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `This machine runs as a metro agent. Standing rules, kept in the metro-orchestrator skill:\n\n${text}` } })}\n`,
  );
