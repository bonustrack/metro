import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { NameModal } from './NameModal.js';
import { KebabMenu } from './KebabMenu.js';
import { ConfirmModal } from './ConfirmModal.js';
import { opensElsewhere } from './link.js';
import { routeHash } from '../route.js';
import { whenLabel } from '../api/when.js';
import { createClaudeSkill, deleteClaudeSkill, type ClaudeSkill, type SkillListing, type SkillPlace } from '../api/claude.js';
import { queryError, refreshClaudeSkills, useClaudeSkillsQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { useDocumentTitle } from '../title.js';

const WHAT =
  'A skill is a folder of instructions Claude Code loads when the work matches it. These live on this machine: the first group is your whole account, the others belong to a project Claude Code has worked in.';
const SKILLS_SINCE = '0.1.0-beta.87';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_HELP = 'A skill name is lowercase letters, digits and dashes, like write-as-less.';

const placeLabel = (place: SkillPlace): string =>
  place.scope === 'user' ? 'This machine' : (place.where.split('/').pop() ?? place.where);

function SkillRow({ skill, project, onOpen, onDelete }: { skill: ClaudeSkill; project: string; onOpen: () => void; onDelete: () => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row justify="between" align="center" gap={12} padding={{ y: 12 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Col gap={2} style={SHRINK}>
        <a
          className="hint-link"
          href={routeHash({ kind: 'skill', project, id: skill.id })}
          onClick={(e) => {
            if (opensElsewhere(e)) return;
            e.preventDefault();
            onOpen();
          }}
        >
          <Text size="md" numberOfLines={1}>{skill.title}</Text>
        </a>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {skill.description === '' ? skill.path : skill.description}
        </Text>
      </Col>
      <Row gap={10} align="center">
        <Text size="sm" role="secondary">{skill.updatedAt === null ? '' : whenLabel(skill.updatedAt)}</Text>
        <KebabMenu
          label={`Actions for ${skill.name}`}
          items={[
            { label: 'Edit', onSelect: onOpen },
            { label: 'Delete', danger: true, onSelect: onDelete },
          ]}
        />
      </Row>
    </Row>
  );
}

interface PlaceSectionProps {
  place: SkillPlace;
  skills: ClaudeSkill[];
  project: string;
  onOpen: (id: string) => void;
  onDelete: (skill: ClaudeSkill) => void;
  onNew: (place: SkillPlace) => void;
}

function PlaceSection({ place, skills, project, onOpen, onDelete, onNew }: PlaceSectionProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={8}>
      <Row justify="between" align="center" gap={12}>
        <Col gap={2} style={SHRINK}>
          <Text size="lg" weight="semibold">{placeLabel(place)}</Text>
          {place.scope === 'user' ? null : <Text size="sm" role="secondary" numberOfLines={1}>{place.where}</Text>}
        </Col>
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          label="New skill"
          onPress={() => {
            onNew(place);
          }}
        />
      </Row>
      {skills.length === 0 ? (
        <Text size="sm" role="secondary">No skill here yet.</Text>
      ) : (
        <Col>
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              project={project}
              onOpen={() => {
                onOpen(skill.id);
              }}
              onDelete={() => {
                onDelete(skill);
              }}
            />
          ))}
        </Col>
      )}
    </Col>
  );
}

interface ListingProps {
  old: boolean;
  error: unknown;
  data: SkillListing | undefined;
  project: string;
  onOpen: (id: string) => void;
  onDelete: (skill: ClaudeSkill) => void;
  onNew: (place: SkillPlace) => void;
}

function Listing({ old, error, data, project, onOpen, onDelete, onNew }: ListingProps): ReactNode {
  if (old)
    return (
      <Text size="sm" role="secondary">
        {`Skills need metro ${SKILLS_SINCE} or newer on this machine. Update it on the Server tab.`}
      </Text>
    );
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the skills on this machine.')}</Text>;
  if (data === undefined) return <Loading />;
  return (
    <Col gap={24}>
      {data.places.map((place) => (
        <PlaceSection
          key={place.id}
          place={place}
          project={project}
          skills={data.skills.filter((skill) => skill.id.startsWith(`${place.id}:`))}
          onOpen={onOpen}
          onDelete={onDelete}
          onNew={onNew}
        />
      ))}
    </Col>
  );
}

export function Skills({ project, onOpen }: { project: string; onOpen: (id: string) => void }): ReactNode {
  const client = useQueryClient();
  const mode = useModeQuery();
  const old = olderThan(mode.data?.version ?? null, SKILLS_SINCE);
  const { data, error } = useClaudeSkillsQuery(!old);
  const [naming, setNaming] = useState<SkillPlace | null>(null);
  const [dropping, setDropping] = useState<ClaudeSkill | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  useDocumentTitle('Skills');

  const drop = (): void => {
    if (dropping === null) return;
    setBusy(true);
    setDropError(null);
    deleteClaudeSkill(dropping.id)
      .then(() => refreshClaudeSkills(client))
      .then(() => {
        setDropping(null);
      })
      .catch((err: unknown) => {
        setDropError(queryError(err, 'Could not delete that skill.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Col gap={20}>
      <Col gap={8}>
        <PageTitle>Skills</PageTitle>
        <Text size="sm" role="secondary">{WHAT}</Text>
      </Col>
      <Listing old={old} error={error} data={data} project={project} onOpen={onOpen} onDelete={setDropping} onNew={setNaming} />
      <NameModal
        title={naming === null ? 'New skill' : `New skill in ${placeLabel(naming)}`}
        action="Create"
        placeholder="write-as-less"
        failure={NAME_HELP}
        open={naming !== null}
        onClose={() => {
          setNaming(null);
        }}
        onSubmit={async (name) => {
          if (!NAME_RE.test(name)) throw new Error(NAME_HELP);
          const made = await createClaudeSkill(name, naming?.id ?? 'user');
          await refreshClaudeSkills(client);
          onOpen(made.id);
          return made.id;
        }}
      />
      <ConfirmModal
        open={dropping !== null}
        title="Delete skill"
        lines={[
          "This removes the skill's folder on that machine, and everything in it.",
          'Claude Code stops loading it at once.',
        ]}
        prompt={`Type ${dropping?.name ?? ''} to confirm.`}
        confirmWord={dropping?.name ?? ''}
        confirmLabel="Delete skill"
        busy={busy}
        error={dropError}
        onClose={() => {
          setDropping(null);
          setDropError(null);
        }}
        onConfirm={drop}
      />
    </Col>
  );
}
