import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { setClaudeSystemPrompt, type ClaudeSetup as Setup } from '@metro-labs/client/api/claude-box';
import { queryError, refresh } from '../lib/queries.js';
import { GROW } from '../lib/style.js';

const EDITOR = { minHeight: 160, lineHeight: 22 } as const;
const NO_ASSIST = { multiline: true, autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;
const NOTE = 'Who your agent is and how it behaves. To save, let work finish and press Stop, then Start.';

export function SystemPromptEditor({ setup }: { setup: Setup }): ReactNode {
  const client = useQueryClient();
  const [draft, setDraft] = useState(setup.systemPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(setup.systemPrompt);
  }, [setup.systemPrompt]);
  const changed = draft.trim() !== setup.systemPrompt;
  const save = (): void => {
    setBusy(true);
    setError(null);
    setClaudeSystemPrompt(draft)
      .then(() => refresh(client, 'claude-setup'))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the system prompt.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Column gap={10}>
      <Text size="xs" color="secondary">{NOTE}</Text>
      <FormField label="System prompt"
        name="system-prompt"
        value={draft}
        disabled={busy}
        placeholder="You are Lisa, the ops agent for Acme. Answer in French. Keep replies short."
        onChangeText={setDraft}
        style={[GROW, EDITOR]}
        inputProps={NO_ASSIST}
      />
      <Row gap={10} align="center" wrap>
        <Button size="lg" color="primary" label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || !changed} onPress={save} />
        {changed && !busy ? (
          <Button
            size="md"
            color="secondary"
            label="Revert"
            onPress={() => {
              setDraft(setup.systemPrompt);
            }}
          />
        ) : null}
        {error === null ? null : <Text size="md" color="danger">{error}</Text>}
      </Row>
    </Column>
  );
}
