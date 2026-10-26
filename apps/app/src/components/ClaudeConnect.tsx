import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { claudeTokenReady } from '@metro-labs/client/api/claude';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { addOrgModel, updateOrgModel } from '@metro-labs/client/api/org-models';
import { FormField } from './FormField.js';
import { FieldLabel } from './FieldLabel.js';
import { TextLink } from './TextLink.js';
import { Actions } from './ui/Actions.js';
import { GROW } from '../lib/style.js';
import { queryError } from '../lib/queries.js';
import { afterModelChange } from '../lib/model-queries.js';

const PLAN_NOTE = 'Needs a Claude Pro or Max plan. The token lasts about a year, and every agent of the organization can use it.';
const AGAIN_NOTE = 'Paste a new token to replace the one this account holds. The routes stay.';
const HOW = 'On your computer, with Claude Code installed, run claude setup-token, sign in, then paste the token here.';
const CLAUDE_SETTINGS_URL = 'https://claude.ai/settings';
export const REVOKE_NOTE = 'Replacing or removing a token in Metro does not revoke it at Anthropic. Revoke old ones in your Claude settings:';
const INPUT = { autoCapitalize: 'none', autoComplete: 'off', autoCorrect: false, spellCheck: false } as const;

function useSaveToken(connection: ConnectionRow | null, onDone: () => void): { busy: boolean; error: string | null; save: (token: string) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (token: string): void => {
    setBusy(true);
    setError(null);
    const job = connection === null ? addOrgModel({ provider: 'anthropic', label: '', claudeToken: token }) : updateOrgModel(connection.id, { claudeToken: token });
    job
      .then(() => afterModelChange(client))
      .then(onDone)
      .catch((err: unknown) => { setError(queryError(err, 'Could not save the Claude subscription.')); })
      .finally(() => { setBusy(false); });
  };
  return { busy, error, save };
}

function RevokeNote(): ReactNode {
  return (
    <Column gap={2}>
      <Text size="xs" color="secondary">{REVOKE_NOTE}</Text>
      <TextLink size="xs" url={CLAUDE_SETTINGS_URL}>{CLAUDE_SETTINGS_URL}</TextLink>
    </Column>
  );
}

function PasteToken({ connection, onDone }: { connection: ConnectionRow | null; onDone: () => void }): ReactNode {
  const [draft, setDraft] = useState('');
  const { busy, error, save } = useSaveToken(connection, onDone);
  const ready = claudeTokenReady(draft);
  return (
    <Column gap={12}>
      <Text size="md">{HOW}</Text>
      <FormField label="Claude token" name="claude-token" variant="obscured" value={draft} placeholder="sk-ant-oat01-…" onChangeText={setDraft} style={GROW} inputProps={INPUT} />
      {draft.trim() === '' || ready ? null : <Text size="xs" color="danger">This is not a Claude token. It starts with sk-ant-oat01-.</Text>}
      <Actions error={error} main={{ label: busy ? 'Checking…' : 'Save', busy, disabled: !ready, onPress: () => { save(draft.trim()); } }} />
    </Column>
  );
}

export function ClaudeConnect({ connection, onDone, children }: { connection: ConnectionRow | null; onDone: () => void; children?: ReactNode }): ReactNode {
  return (
    <Column gap={24}>
      <Column gap={12}>
        <FieldLabel>Claude subscription</FieldLabel>
        <Text size="md" color="secondary">{connection === null ? PLAN_NOTE : AGAIN_NOTE}</Text>
        <PasteToken connection={connection} onDone={onDone} />
        <RevokeNote />
      </Column>
      {children === undefined ? null : (
        <Column gap={12}>
          <FieldLabel>Or an API key</FieldLabel>
          {children}
        </Column>
      )}
    </Column>
  );
}
