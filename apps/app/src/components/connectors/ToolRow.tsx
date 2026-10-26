import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { PermissionControl } from '../ui/PermissionControl.js';
import { side } from '../ui/edges.js';
import { ICON_SIZE, READABLE_WIDTH } from '../ui/sizes.js';
import { ToolInputs } from './ToolInputs.js';
import { copyText } from '../../lib/clipboard.js';
import type { ExplorerTool } from '../../lib/connector-rules.js';
import { logError } from '../../lib/log.js';
import { useIsNarrow } from '../../lib/media.js';
import { CHOICE_WORD, type PermissionChoice } from '../../lib/permission-words.js';
import { MONO, SHRINK } from '../../lib/style.js';

const COPIED_MS = 1500;
const UNLISTED = 'The service does not list this tool now. Its saved rule stays, and it counts as Write.';

const styles = StyleSheet.create({ toggle: { flex: 1, minWidth: 0 }, chevron: { alignSelf: 'flex-start', paddingTop: 2 }, copy: { padding: 4, margin: -4 } });

export interface StricterName {
  name: string;
  choice: PermissionChoice;
}

interface ToolRowProps {
  tool: ExplorerTool;
  choice: PermissionChoice;
  floor: PermissionChoice | null;
  stricter: StricterName[];
  disabled: boolean;
  onChange: (choice: PermissionChoice) => void;
}

function CopyName({ name }: { name: string }): ReactNode {
  const palette = useKitPalette();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    copyText(name)
      .then((done) => {
        setCopied(done);
        setTimeout(() => { setCopied(false); }, COPIED_MS);
      })
      .catch(logError('copy-tool-name'));
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : `Copy ${name}`} onPress={copy} style={styles.copy}>
      <Icon name={copied ? 'check' : 'copy'} size={ICON_SIZE.sm} color={palette.sub} />
    </Pressable>
  );
}

function Badges({ tool }: { tool: ExplorerTool }): ReactNode {
  if (!tool.destructive && !tool.openWorld) return null;
  return (
    <Row gap={6} wrap>
      {tool.destructive ? <Badge label="Deletes" color="danger" variant="soft" /> : null}
      {tool.openWorld ? <Badge label="Reaches the web" color="secondary" variant="soft" /> : null}
    </Row>
  );
}

function Names({ tool, narrow }: { tool: ExplorerTool; narrow: boolean }): ReactNode {
  const titled = tool.title !== tool.name;
  return (
    <Row align="center" gap={8} wrap>
      {titled ? <Text size="md" style={SHRINK}>{tool.title}</Text> : null}
      {titled && narrow ? null : (
        <Row align="center" gap={6}>
          <Text size={titled ? 'xs' : 'md'} role={titled ? 'secondary' : undefined} style={MONO}>
            {tool.name}
          </Text>
          <CopyName name={tool.name} />
        </Row>
      )}
    </Row>
  );
}

function Summary({ tool, floor, choice, narrow }: { tool: ExplorerTool; floor: PermissionChoice | null; choice: PermissionChoice; narrow: boolean }): ReactNode {
  const description = tool.listed ? tool.description : UNLISTED;
  return (
    <Col flex={1} minWidth={0} gap={4}>
      <Names tool={tool} narrow={narrow} />
      {narrow && tool.title !== tool.name ? (
        <Row align="center" gap={6}>
          <Text size="xs" role="secondary" style={MONO}>{tool.name}</Text>
          <CopyName name={tool.name} />
        </Row>
      ) : null}
      {description === '' ? null : <Text size="xs" role="secondary" numberOfLines={narrow ? 2 : 1}>{description}</Text>}
      {floor !== null && floor !== choice ? <Text size="xs" role="secondary">{`Organization: ${CHOICE_WORD[floor]}`}</Text> : null}
      {narrow ? <Badges tool={tool} /> : null}
    </Col>
  );
}

function Details({ tool, stricter }: { tool: ExplorerTool; stricter: StricterName[] }): ReactNode {
  return (
    <Col gap={20} padding={{ bottom: 18 }}>
      {tool.listed && tool.description !== '' ? (
        <Col maxWidth={READABLE_WIDTH}>
          <Text size="md">{tool.description}</Text>
        </Col>
      ) : null}
      <ToolInputs schema={tool.inputSchema} />
      {stricter.length === 0 ? null : (
        <Col gap={6}>
          <Text size="xs" role="secondary">Agents with a stricter rule</Text>
          <Text size="md">{stricter.map((agent) => `${agent.name}: ${CHOICE_WORD[agent.choice]}`).join(' · ')}</Text>
        </Col>
      )}
    </Col>
  );
}

export function ToolRow({ tool, choice, floor, stricter, disabled, onChange }: ToolRowProps): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const [open, setOpen] = useState(false);
  const toggle = (): void => { setOpen(!open); };
  return (
    <Col border={{ bottom: side(palette.border) }}>
      <Row align="center" gap={narrow ? 8 : 12} padding={{ y: 14 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${open ? 'Hide' : 'Show'} details of ${tool.title}`} accessibilityState={{ expanded: open }} onPress={toggle} style={styles.chevron}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.md} color={palette.sub} />
        </Pressable>
        <Pressable accessible={false} focusable={false} onPress={toggle} style={styles.toggle}>
          <Summary tool={tool} floor={floor} choice={choice} narrow={narrow} />
        </Pressable>
        {narrow ? null : <Badges tool={tool} />}
        <PermissionControl label={tool.title} value={choice} atLeast={floor} disabled={disabled} onChange={onChange} size={narrow ? 'sm' : 'md'} />
      </Row>
      {open ? (
        <Col padding={{ left: narrow ? 28 : 32 }}>
          <Details tool={tool} stricter={stricter} />
        </Col>
      ) : null}
    </Col>
  );
}
