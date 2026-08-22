import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { NameModal } from './NameModal';
import { ConfirmModal } from './ConfirmModal';
import { Loading } from './Loading';
import { deleteProject, renameProject, type Project } from '../api/projects';
import { queryError, refreshProjects, useProjectsQuery } from '../api/queries';
import { useDocumentTitle } from '../title';

const OWNER_NOTE = 'Only the owner can delete a project.';


function ProjectFields({
  row,
  dark,
  locked,
  busy,
  onRename,
  onDelete,
}: {
  row: Project;
  dark: boolean;
  locked: boolean;
  busy: boolean;
  onRename: () => void;
  onDelete: () => void;
}): ReactNode {
  return (
    <>
      <Col gap={10}>
        <Text weight="semibold">Name</Text>
        <Row gap={8} align="center" wrap>
          <Text size="sm" role="secondary">
            {row.name}
          </Text>
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            disabled={row.role !== 'admin'}
            label="Rename"
            onPress={onRename}
          />
        </Row>
      </Col>
      {row.isDefault ? null : (
        <Col gap={10}>
          <Text weight="semibold">Delete</Text>
          {row.owner ? null : (
            <Text size="sm" role="secondary">
              {OWNER_NOTE}
            </Text>
          )}
          <Row>
            <Button
              color="danger"
              dark={dark}
              disabled={locked || busy}
              label="Delete project"
              onPress={onDelete}
            />
          </Row>
        </Col>
      )}
    </>
  );
}

function guard(
  error: unknown,
  data: Project[] | undefined,
  row: Project | undefined,
): ReactNode {
  if (error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(error, 'Could not load the project.')}
      </Text>
    );
  if (data === undefined) return <Loading />;
  if (row === undefined)
    return (
      <Text size="sm" role="secondary">
        No such project.
      </Text>
    );
  return null;
}

interface ProjectSettingsProps {
  token: string;
  project: string;
  onGone: () => void;
}

export function ProjectSettings({
  token,
  project,
  onGone,
}: ProjectSettingsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useProjectsQuery(token);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const row = (data ?? []).find((p) => p.id === project);
  useDocumentTitle(row?.name ?? 'Project');

  const remove = (): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    deleteProject(token, project)
      .then(() => {
        refreshProjects(client);
        setConfirming(false);
        onGone();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not delete the project.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const blocked = guard(error, data, row);
  if (blocked !== null) return blocked;
  if (row === undefined) return null;

  const locked = row.isDefault || !row.owner;

  return (
    <Col gap={20}>
      <PageTitle>{row.name}</PageTitle>
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
      <ProjectFields
        row={row}
        dark={dark}
        locked={locked}
        busy={busy}
        onRename={() => {
          setRenaming(true);
        }}
        onDelete={() => {
          setConfirming(true);
        }}
      />
      <NameModal
        key={row.name}
        title="Rename project"
        action="Rename"
        placeholder={row.name}
        initial={row.name}
        failure="Could not rename the project."
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onSubmit={async (name) => {
          const next = await renameProject(token, project, name);
          refreshProjects(client);
          return next;
        }}
      />
      <ConfirmModal
        open={confirming}
        title="Delete project"
        lines={[
          `'${row.name}' and everything scoped to it will be gone.`,
          'Its agents, connectors and collections must be removed first.',
        ]}
        prompt={`Type ${row.name} to confirm.`}
        confirmWord={row.name}
        confirmLabel="Delete project"
        busy={busy}
        error={failed}
        onClose={() => {
          setConfirming(false);
        }}
        onConfirm={remove}
      />
    </Col>
  );
}
