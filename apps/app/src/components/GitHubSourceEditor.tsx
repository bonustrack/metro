import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { changeSkillSource, type GitHubSkillSource } from '@metro-labs/client/api/skill-source';
import { refreshClaudeSkills } from '../lib/queries.js';
import { useKeyboardInset } from '../lib/useKeyboardInset.js';
import { FormField } from './FormField.js';
import { Modal } from './Modal.js';
import { useSave, type Saving } from './SaveField.js';
import { useStacked } from './SettingsSection.js';
import { TextLink } from './TextLink.js';

const INPUT = { autoCapitalize: 'none', autoCorrect: false, autoComplete: 'off', spellCheck: false } as const;
const TRUST = 'Repository writers can change your agent’s instructions. Connect only a repository you trust. Sync never runs its scripts, but the agent can use them later under its normal permissions. This is not a sandbox.';
const FORMAT = 'Each skill needs a name matching its folder. Hooks, tool grants, model overrides and shell substitutions are not imported. Local skills stay editable and win name conflicts.';

function Footer({ saving, onClose }: { saving: Saving; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  return (
    <Col gap={8} padding={{ x: 16, top: 12 }} border={{ top: { width: 1, color: palette.border } }}>
      {saving.error === null ? null : <Text size="2xs" role="danger" accessibilityLiveRegion="polite">{saving.error}</Text>}
      <Row gap={8} justify="end" wrap>
        <Button size="lg" color="secondary" dark={dark} label="Cancel" disabled={saving.busy} onPress={onClose} />
        <Button size="lg" dark={dark} label={saving.busy ? 'Saving…' : 'Save'} accessibilityLabel={saving.busy ? 'Saving…' : 'Save'} loading={saving.busy} disabled={!saving.ready || saving.busy} onPress={saving.save} />
      </Row>
    </Col>
  );
}

function TokenHelp({ editing }: { editing: boolean }): ReactNode {
  return <>
    {editing ? <Text size="2xs" role="secondary">Paste a token to save changes. The stored token is never shown.</Text> : null}
    <Text size="2xs" role="secondary">Only an administrator can connect a source. Use a fine-grained token for this repository only, with Contents read-only and an expiry. Your organization may need to approve it. The token stays on the daemon, outside the agent’s files and exports.</Text>
    <TextLink url="https://github.com/settings/personal-access-tokens/new">Create a fine-grained GitHub token</TextLink>
  </>;
}

export function GitHubSourceEditor({ view, onClose }: { view: GitHubSkillSource; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const sheet = useStacked();
  const bottomInset = useKeyboardInset();
  const [repository, setRepository] = useState(view.source?.repository ?? '');
  const [ref, setRef] = useState(view.source?.ref ?? 'main');
  const [folder, setFolder] = useState(view.source?.folder ?? 'skills');
  const saving = useSave({
    initial: '', valid: (token) => token !== '' && repository.trim() !== '' && ref.trim() !== '',
    failure: 'Could not save the skills source.',
    run: async (token) => {
      try {
        await changeSkillSource('PUT', { repository: repository.trim(), ref: ref.trim(), folder: folder.trim(), token });
        await refreshClaudeSkills(client);
        onClose();
      } finally { saving.setValue(''); }
    },
  });
  return (
    <Modal title={view.source === null ? 'Add GitHub sync' : 'Edit GitHub sync'} open onClose={onClose} dismissable={!saving.busy}
      side={sheet ? 'bottom' : 'center'} bottomInset={bottomInset} footer={<Footer saving={saving} onClose={onClose} />}>
      <Col gap={12} padding={{ bottom: 16 }}>
        <FormField label="Repository" name="github-skills-repository" value={repository} onChangeText={setRepository} placeholder="organization/skills" dark={dark} disabled={saving.busy} inputProps={INPUT} />
        <FormField label="Branch, tag or commit" name="github-skills-ref" value={ref} onChangeText={setRef} dark={dark} disabled={saving.busy} inputProps={INPUT} />
        <Col gap={6}>
          <FormField label="Skills folder" name="github-skills-folder" value={folder} onChangeText={setFolder} placeholder="skills" dark={dark} disabled={saving.busy} inputProps={INPUT} />
          <Text size="2xs" role="secondary">Use a relative path, such as skills, containing skill-name/SKILL.md. Leave empty for the repository root.</Text>
        </Col>
        <Col gap={6}>
          <FormField label="Read-only token" name="github-skills-token" value={saving.value} onChangeText={saving.setValue} placeholder="github_pat_…" inputType="password" dark={dark} disabled={saving.busy} inputProps={INPUT} onSubmit={saving.save} />
          <TokenHelp editing={view.source !== null} />
        </Col>
        <Text size="2xs" role="secondary">{TRUST}</Text>
        <Text size="2xs" role="secondary">{FORMAT}</Text>
      </Col>
    </Modal>
  );
}
