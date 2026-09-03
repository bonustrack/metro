import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { Dropdown, type MenuItem } from './Dropdown';
import { NAV_ICON_SIZE, NAV_ROW_BOX } from './NavRow';
import { NameModal } from './NameModal';
import { createProject } from '../api/projects';
import { refreshProjects, useModeQuery, useProjectsQuery } from '../api/queries';
import { type Selection } from './selection';

interface ProjectSwitcherProps {
  token: string;
  project: string;
  onSelect: (selection: Selection) => void;
}

export function ProjectSwitcher({
  token,
  project,
  onSelect,
}: ProjectSwitcherProps): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const { data } = useProjectsQuery(token);
  const local = useModeQuery().data?.mode === 'local';
  const [creating, setCreating] = useState(false);

  const projects = data ?? [];
  const current = projects.find((p) => p.id === project);

  const items: MenuItem[] = projects.map((p) => ({
    label: p.id === project ? `${p.name} ✓` : p.name,
    onSelect: () => {
      onSelect({ kind: 'agents', project: p.id });
    },
  }));
  if (!local)
    items.push({
      label: 'Add project',
      icon: 'plus',
      onSelect: () => {
        setCreating(true);
      },
    });

  return (
    <>
      <Dropdown
        className="project-trigger"
        label="Switch project"
        align="start"
        items={items}
      >
        <Row {...NAV_ROW_BOX}>
          <Icon name="folder" size={NAV_ICON_SIZE} color={palette.sub} />
          <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>
            {current?.name ?? 'Project'}
          </Text>
        </Row>
      </Dropdown>
      <NameModal
        title="New project"
        action="Create"
        placeholder="my project"
        failure="Could not create the project."
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onSubmit={async (name) => {
          const made = await createProject(token, name);
          refreshProjects(client);
          onSelect({ kind: 'agents', project: made.id });
          return made;
        }}
      />
    </>
  );
}
