import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, Platform, ScrollView } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { AGENT_TABS, agentPageOf, agentTabOf, shallowPages, type AgentPage } from '../../lib/agent-tabs.js';
import { go } from '../../lib/nav.js';
import { openExternal } from '../../lib/open.js';
import { side } from '../ui/edges.js';
import { optionTabs } from '../../lib/option-tabs.js';

const PAGE_MIN = 96;
const CHAR = 8.5;
const PAGE_PAD = 28;
const TAB_GAP = 16;

const pageWidth = (pages: readonly AgentPage[]): number => Math.max(PAGE_MIN, ...pages.map((page) => Math.round(page.label.length * CHAR + PAGE_PAD)));

function open(page: AgentPage, project: string): void {
  const target = page.target(project);
  if (page.newTab === true && Platform.OS === 'web') openExternal(`${window.location.pathname}${routeHash(target)}`);
  else go(target);
}

interface KeptInView {
  ref: RefObject<ScrollView | null>;
  onLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number) => void;
}

function useKeptInView(labels: readonly string[], index: number): KeptInView {
  const ref = useRef<ScrollView>(null);
  const [view, setView] = useState(0);
  const [content, setContent] = useState(0);
  useEffect(() => {
    if (view === 0 || content <= view || index < 0) return;
    ref.current?.scrollTo({ x: tabCenterOffset(labels, index, content, view), animated: false });
  }, [labels, index, view, content]);
  return { ref, onLayout: (event) => { setView(event.nativeEvent.layout.width); }, onContentSizeChange: setContent };
}

function tabCenterOffset(labels: readonly string[], index: number, content: number, view: number): number {
  const letters = labels.reduce((sum, label) => sum + label.length, 0);
  const perLetter = (content - TAB_GAP * (labels.length - 1)) / Math.max(1, letters);
  const before = labels.slice(0, index).reduce((sum, label) => sum + label.length, 0);
  const center = before * perLetter + index * TAB_GAP + ((labels[index]?.length ?? 0) * perLetter) / 2;
  return Math.min(Math.max(0, center - view / 2), content - view);
}

const TAB_LABELS = AGENT_TABS.map((tab) => tab.label);

export function AgentTabs({ selection, project }: { selection: Selection; project: string }): ReactNode {
  const palette = useKitPalette();
  const current = agentTabOf(selection.kind);
  const kept = useKeptInView(TAB_LABELS, AGENT_TABS.indexOf(current));
  return (
    <Column border={{ bottom: side(palette.border) }}>
      <ScrollView ref={kept.ref} horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Agent pages" onLayout={kept.onLayout} onContentSizeChange={kept.onContentSizeChange}>
        <Tabs
          variant="underline"
          {...optionTabs(AGENT_TABS.map((tab) => ({ value: tab.id, label: tab.label })), current.id, (id) => {
            const tab = AGENT_TABS.find((t) => t.id === id);
            if (tab !== undefined) go(tab.target(project));
          })}
        />
      </ScrollView>
    </Column>
  );
}

export function AgentSubPages({ selection, project }: { selection: Selection; project: string }): ReactNode {
  const pages = shallowPages(agentTabOf(selection.kind));
  const current = agentPageOf(selection.kind);
  if (pages.length < 2 || current?.deep === true) return null;
  const track = { width: pages.length * pageWidth(pages) };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel={agentTabOf(selection.kind).label}>
      <Column style={track}>
        <Tabs
          {...optionTabs(pages.map((page) => ({ value: page.label, label: page.label })), current?.label ?? '', (label) => {
            const page = pages.find((p) => p.label === label);
            if (page !== undefined) open(page, project);
          })}
        />
      </Column>
    </ScrollView>
  );
}
