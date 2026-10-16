import { type ReactNode } from 'react';
import { Platform, ScrollView } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { AGENT_TABS, agentPageOf, agentTabOf, shallowPages, type AgentPage } from '../../lib/agent-tabs.js';
import { go } from '../../lib/nav.js';
import { openExternal } from '../../lib/open.js';
import { side } from '../ui/edges.js';

const PAGE_MIN = 96;
const CHAR = 8.5;
const PAGE_PAD = 28;

const pageWidth = (pages: readonly AgentPage[]): number => Math.max(PAGE_MIN, ...pages.map((page) => Math.round(page.label.length * CHAR + PAGE_PAD)));

function open(page: AgentPage, project: string): void {
  const target = page.target(project);
  if (page.newTab === true && Platform.OS === 'web') openExternal(`${window.location.pathname}${routeHash(target)}`);
  else go(target);
}

export function AgentTabs({ selection, project }: { selection: Selection; project: string }): ReactNode {
  const palette = useKitPalette();
  const current = agentTabOf(selection.kind);
  return (
    <Col border={{ bottom: side(palette.border) }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Agent pages">
        <Tabs
          variant="underline"
          value={current.id}
          options={AGENT_TABS.map((tab) => ({ value: tab.id, label: tab.label }))}
          onChange={(id) => {
            const tab = AGENT_TABS.find((t) => t.id === id);
            if (tab !== undefined) go(tab.target(project));
          }}
        />
      </ScrollView>
    </Col>
  );
}

export function AgentSubPages({ selection, project }: { selection: Selection; project: string }): ReactNode {
  const pages = shallowPages(agentTabOf(selection.kind));
  const current = agentPageOf(selection.kind);
  if (pages.length < 2 || current?.deep === true) return null;
  const track = { width: pages.length * pageWidth(pages) };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel={agentTabOf(selection.kind).label}>
      <Col style={track}>
        <Tabs
          value={current?.label ?? ''}
          options={pages.map((page) => ({ value: page.label, label: page.label }))}
          onChange={(label) => {
            const page = pages.find((p) => p.label === label);
            if (page !== undefined) open(page, project);
          }}
        />
      </Col>
    </ScrollView>
  );
}
