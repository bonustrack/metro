import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { setClaudeSystemPrompt, type ClaudeSetup as Setup } from '../api/claude-box.js';
import { queryError, refreshClaudeSetup } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { GROW } from '../theme.js';

export const PROMPT_SINCE = '0.1.0-beta.133';
const EDITOR = { minHeight: 160, lineHeight: 22 } as const;
const NO_ASSIST = { multiline: true, autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;
const NOTE =
  'Text here is appended to Claude Code’s own system prompt on every session metro starts here (the --append-system-prompt flag). Saving restarts the Claude session, which resumes the same conversation with the new prompt.';

export function SystemPromptEditor({ setup, version }: { setup: Setup; version: string | null }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState(setup.systemPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(setup.systemPrompt);
  }, [setup.systemPrompt]);
  if (olderThan(version, PROMPT_SINCE))
    return (
      <Col gap={4}>
        <Text size="md" weight="semibold">System prompt</Text>
        <Text size="sm" role="secondary">A system prompt needs metro {PROMPT_SINCE} or newer on the machine. Update first.</Text>
      </Col>
    );
  const changed = draft.trim() !== setup.systemPrompt;
  const save = (): void => {
    setBusy(true);
    setError(null);
    setClaudeSystemPrompt(draft)
      .then(() => refreshClaudeSetup(client))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the system prompt.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={10}>
      <Text size="md" weight="semibold">System prompt</Text>
      <Text size="sm" role="secondary">{NOTE}</Text>
      <Input
        name="system-prompt"
        value={draft}
        dark={dark}
        disabled={busy}
        placeholder="You are Lisa, the ops agent for Acme. Answer in French. Keep replies short."
        onChangeText={setDraft}
        style={[GROW, EDITOR]}
        inputProps={NO_ASSIST}
      />
      <Row gap={10} align="center" wrap>
        <Button size="sm" color="primary" dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || !changed} onPress={save} />
        {changed && !busy ? (
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            label="Revert"
            onPress={() => {
              setDraft(setup.systemPrompt);
            }}
          />
        ) : null}
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
      </Row>
    </Col>
  );
}
