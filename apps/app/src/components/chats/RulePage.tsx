import { type ReactNode, useRef, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { stationFields } from '@metro-labs/client/api/accounts';
import { setPolicy, stationLabel } from '@metro-labs/client/api/attach';
import { Icon } from '../Icon.js';
import { Item } from '../ui/Item.js';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { type ChannelProps } from './channel-props.js';
import { channelTitle } from './ChannelRow.js';
import { RulePreview } from './RulePreview.js';
import { Group } from '../ui/Group.js';
import {
  ACCESS_WORD, RULE_ACCESS, choiceOf, mixedNote, offersSame, ruleText, ruleTitle, sameAs, targetTool, withChoice, type RuleChoice, type RuleTarget,
} from '../../lib/channel-rules.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';
import { MONO } from '../../lib/style.js';

const MARK = 22;
const SAVE_FAILED = 'Could not save the rule.';

interface Option {
  choice: RuleChoice;
  title: string;
  text: string;
}

function optionsOf({ found, view }: ChannelProps, target: RuleTarget, name: string): Option[] {
  const text = ruleText(target, name);
  const own: Option[] = RULE_ACCESS.map((access) => ({ choice: access, title: ACCESS_WORD[access], text: text[access] }));
  if (!offersSame(target)) return own;
  const same = sameAs(found.row.policy, view.tools[found.station] ?? [], target);
  return [{ choice: 'same', title: `Same as ${same.row}`, text: `Follows ${same.row}, now ${ACCESS_WORD[same.access]}.` }, ...own];
}

function useSaveRule({ agentId, found, view, onSaved }: ChannelProps, target: RuleTarget): { busy: boolean; error: string | null; pick: (choice: RuleChoice) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const { station, row } = found;
  const pick = (choice: RuleChoice): void => {
    const id = row.id;
    if (pending.current || id === null) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setPolicy(agentId, station, id, withChoice(row.policy, view.tools[station] ?? [], target, choice))
      .then(() => onSaved())
      .catch((err: unknown) => { setError(queryError(err, SAVE_FAILED)); })
      .finally(() => { pending.current = false; setBusy(false); });
  };
  return { busy, error, pick };
}

export function RulePage(props: ChannelProps & { target: RuleTarget; channelHref: string }): ReactNode {
  const { project, found, view, target, channelHref } = props;
  const palette = useKitPalette();
  const name = useAgentName();
  const technical = useTechnicalDetails();
  const title = ruleTitle(target);
  const tool = targetTool(target);
  const saving = useSaveRule(props, target);
  useDocumentTitle(title);
  const current = choiceOf(found.row.policy, view.tools[found.station] ?? [], target);
  const trail = [{ label: stationLabel(found.station), href: channelHref }, ...(tool === null ? [] : [{ label: 'Exceptions', href: `${channelHref}/exceptions` }]), { label: title }];
  return (
    <AgentDeepPage project={project} tab="chats" trail={trail} title={title} subtitle={technical && tool !== null ? <Text size="xs" role="secondary" style={MONO}>{tool}</Text> : undefined} lead={ruleText(target, name).lead}>
      <Group error={saving.error} note={mixedNote(current)}>
        {optionsOf(props, target, name).map((option) => (
          <Item
            key={option.choice}
            title={option.title}
            subtitle={option.text}
            chevron={false}
            trailing={<Row width={MARK}>{current === option.choice ? <Icon name="check" size={MARK} color={palette.link} /> : null}</Row>}
            onPress={() => { if (!saving.busy && current !== option.choice) saving.pick(option.choice); }}
          />
        ))}
      </Group>
      <RulePreview agentId={props.agentId} found={found} handle={stationFields(found.row).handle ?? channelTitle(found)} target={target} channelHref={channelHref} />
    </AgentDeepPage>
  );
}
