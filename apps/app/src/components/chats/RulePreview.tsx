import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { type FlatAccount } from '@metro-labs/client/api/accounts';
import { stationLabel } from '@metro-labs/client/api/attach';
import { AgentAvatar } from '../AgentAvatar.js';
import { StationIcon } from '../StationIcon.js';
import { Item } from '../ui/Item.js';
import { Section } from './Section.js';
import { useSenderCards } from './use-sender-cards.js';
import { approvesInChat, entriesOf, namesList, peopleOf, questionsGoTo, type Person } from '../../lib/channel-people.js';
import { promptPreview, type RuleTarget } from '../../lib/channel-rules.js';

const SAMPLE_ID = 'kqfmz';
const FACE = 32;
const PLACE = 20;
const BUBBLE_MAX = 440;
const STACKED = 3;

const styles = StyleSheet.create({
  overlap: { marginLeft: -8 },
  tail: { borderBottomLeftRadius: 6 },
});

function Faces({ people }: { people: Person[] }): ReactNode {
  if (people.length === 0) return null;
  return (
    <Row align="center">
      {people.slice(0, STACKED).map((person, index) => (
        <View key={person.id} style={index === 0 ? undefined : styles.overlap}>
          <AgentAvatar seed={person.id} src={person.avatar} size={FACE} />
        </View>
      ))}
    </Row>
  );
}

function Bubble({ station, target }: { station: string; target: RuleTarget }): ReactNode {
  const palette = useKitPalette();
  const preview = promptPreview(target);
  return (
    <Col background={palette.inputBg} radius={18} padding={{ x: 16, y: 12 }} gap={4} maxWidth={BUBBLE_MAX} style={styles.tail}>
      <Text size="md" weight="semibold">{`Approval needed: ${preview.tool}`}</Text>
      <Text size="md" color={palette.text}>{`${stationLabel(station)} · a group chat`}</Text>
      <Text size="md">{preview.text}</Text>
      <Text size="md" color={palette.text}>{`Reply "yes ${SAMPLE_ID}" or "no ${SAMPLE_ID}"`}</Text>
    </Col>
  );
}

interface RulePreviewProps {
  agentId: string;
  found: FlatAccount;
  handle: string;
  target: RuleTarget;
  channelHref: string;
}

export function RulePreview({ agentId, found, handle, target, channelHref }: RulePreviewProps): ReactNode {
  const { station, row } = found;
  const entries = entriesOf(row.allowlist);
  const cards = useSenderCards(agentId, station, row.id ?? '', entries);
  if (!approvesInChat(station))
    return (
      <Section label="What they get" note="Email is not used for approval questions. They show on Home, where you answer them.">
        {null}
      </Section>
    );
  const approvers = peopleOf({ station, entries, approvers: row.approvers, cards, seen: [], technical: false }).filter((person) => person.approves === true);
  const names = approvers.map((person) => person.title);
  const where = names.length === 0 ? 'Only on Home, since nobody here can approve' : `${questionsGoTo(names, handle).title} with ${handle}`;
  return (
    <>
      <Section label="What they get" note="No answer in 24 hours means no. You can also answer on Home.">
        <Col gap={12} padding={{ top: 8 }}>
          <Row gap={8} align="center">
            <StationIcon station={station} size={PLACE} />
            <Text size="xs" role="secondary" numberOfLines={2}>
              {where}
            </Text>
          </Row>
          <Bubble station={station} target={target} />
        </Col>
      </Section>
      <Section label="Who can answer">
        <Item
          title={names.length === 0 ? 'Nobody yet' : namesList(names)}
          subtitle={names.length === 0 ? 'Turn on Can approve for someone in this channel.' : undefined}
          leading={<Faces people={approvers} />}
          href={channelHref}
        />
      </Section>
    </>
  );
}
