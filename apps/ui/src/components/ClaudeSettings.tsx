import { type ReactNode, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { GROW } from '../theme.js';
import { saveClaudeSettings, type ClaudeSettingsFile } from '../api/claude.js';
import { queryError, refreshClaudeSettings, useClaudeSettingsQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const WHAT =
  'Claude Code reads these files when a session starts on this machine. The first is the one for your whole account; the others belong to a project Claude Code has worked in. A change here reaches the next session, not one already running.';
const EDITOR = { minHeight: 420, lineHeight: 22 } as const;
const EMPTY = '{\n  \n}\n';
const INDENT = 2;

const scopeLabel = (file: ClaudeSettingsFile): string =>
  file.scope === 'user' ? 'This machine' : file.scope === 'local' ? 'Project, not shared' : 'Project';

function parseError(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'Settings must be a JSON object, in braces.';
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'That is not valid JSON.';
  }
}

function FilePicker({ files, chosen, onPick }: { files: ClaudeSettingsFile[]; chosen: string; onPick: (id: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (files.length < 2) return null;
  return (
    <Row gap={8} wrap>
      {files.map((file) => (
        <Button
          key={file.id}
          size="sm"
          dark={dark}
          color={file.id === chosen ? 'primary' : 'secondary'}
          label={file.scope === 'user' ? 'This machine' : `${file.label.split('/').pop() ?? file.label}${file.scope === 'local' ? ' (local)' : ''}`}
          onPress={() => {
            onPick(file.id);
          }}
        />
      ))}
    </Row>
  );
}

function FileNote({ file }: { file: ClaudeSettingsFile }): ReactNode {
  return (
    <Col gap={2}>
      <FieldLabel>{scopeLabel(file)}</FieldLabel>
      <Text size="sm" role="secondary">
        {file.path}
      </Text>
      <Text size="sm" role="secondary">
        {file.modifiedAt === null ? 'No file yet. Saving writes one.' : `Last changed ${whenLabel(file.modifiedAt)}.`}
      </Text>
    </Col>
  );
}

interface EditorProps {
  file: ClaudeSettingsFile;
  draft: string | null;
  onEdit: (text: string) => void;
  onSaved: () => void;
}

interface ActionsProps {
  busy: boolean;
  ready: boolean;
  changed: boolean;
  note: string | null;
  error: string | null;
  onSave: () => void;
  onFormat: () => void;
  onRevert: () => void;
}

function Actions({ busy, ready, changed, note, error, onSave, onFormat, onRevert }: ActionsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={12} align="center" wrap>
      <Button dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || !ready || !changed} onPress={onSave} />
      <Button size="md" color="secondary" dark={dark} label="Format" disabled={busy || !ready} onPress={onFormat} />
      <Button size="md" color="secondary" dark={dark} label="Revert" disabled={busy || !changed} onPress={onRevert} />
      {note === null ? null : (
        <Text size="sm" role="secondary">
          {note}
        </Text>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">
          {error}
        </Text>
      )}
    </Row>
  );
}

function Editor({ file, draft, onEdit, onSaved }: EditorProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? (file.exists ? file.text : EMPTY);
  const broken = useMemo(() => parseError(shown), [shown]);
  const save = (): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    saveClaudeSettings(file.id, shown, file.modifiedAt)
      .then(async () => {
        onSaved();
        await refreshClaudeSettings(client);
        setNote('Saved. The next Claude Code session on this machine reads it.');
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the settings.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={12}>
      <Input
        name="claude-settings"
        value={shown}
        dark={dark}
        disabled={busy || !file.editable}
        onChangeText={onEdit}
        style={[GROW, EDITOR]}
        inputProps={{ multiline: true, autoCapitalize: 'none', autoCorrect: false, spellCheck: false }}
      />
      {broken === null ? null : (
        <Text size="sm" role="danger">
          {broken}
        </Text>
      )}
      <Actions
        busy={busy}
        ready={broken === null && file.editable}
        changed={shown !== file.text}
        note={note}
        error={error}
        onSave={save}
        onFormat={() => {
          onEdit(`${JSON.stringify(JSON.parse(shown), null, INDENT)}\n`);
        }}
        onRevert={() => {
          onSaved();
          setNote(null);
        }}
      />
    </Col>
  );
}

export function ClaudeSettings(): ReactNode {
  const settings = useClaudeSettingsQuery();
  const [chosen, setChosen] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  useDocumentTitle('Claude Code settings');
  const files = settings.data ?? [];
  const file = files.find((f) => f.id === chosen) ?? files[0];
  return (
    <Col gap={20}>
      <Col gap={8}>
        <PageTitle>Claude Code settings</PageTitle>
        <Text size="sm" role="secondary">
          {WHAT}
        </Text>
      </Col>
      {settings.error !== null ? (
        <Text size="sm" role="danger">
          {queryError(settings.error, 'Could not read the settings files.')}
        </Text>
      ) : settings.data === undefined ? (
        <Loading />
      ) : file === undefined ? (
        <Text size="sm" role="secondary">
          Claude Code has left no settings file on this machine.
        </Text>
      ) : (
        <Col gap={16}>
          <FilePicker
            files={files}
            chosen={file.id}
            onPick={(id) => {
              setChosen(id);
              setDraft(null);
            }}
          />
          <FileNote file={file} />
          {file.editable ? null : (
            <Text size="sm" role="danger">
              That file is too large to edit here.
            </Text>
          )}
          <Editor
            file={file}
            draft={draft?.id === file.id ? draft.text : null}
            onEdit={(text) => {
              setDraft({ id: file.id, text });
            }}
            onSaved={() => {
              setDraft(null);
            }}
          />
        </Col>
      )}
    </Col>
  );
}
