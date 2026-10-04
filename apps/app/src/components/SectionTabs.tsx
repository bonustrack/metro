import { type ReactNode } from 'react';
import { Platform, ScrollView } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { PageTitle } from './PageTitle.js';
import { sectionOf } from './sections.js';
import { go } from '../lib/nav.js';
import { openExternal } from '../lib/open.js';

const TAB_WIDTH = 150;

export function SectionTabs({ project, selection }: { project: string; selection: Selection }): ReactNode {
  const section = sectionOf(selection.kind);
  const tabs = section?.tabs;
  if (section === undefined || tabs === undefined) return null;
  const current = tabs.find((tab) => tab.kinds.includes(selection.kind));
  const track = { width: tabs.length * TAB_WIDTH };
  return (
    <Col gap={12}>
      <PageTitle>{section.label}</PageTitle>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel={section.label}>
        <Col style={track} margin={{ bottom: 8 }}>
          <Tabs
            value={current?.label ?? ''}
            options={tabs.map((tab) => ({ value: tab.label, label: tab.label }))}
            onChange={(label) => {
              const tab = tabs.find((t) => t.label === label);
              if (tab === undefined) return;
              const target = tab.target(project);
              if (tab.newTab === true && Platform.OS === 'web') openExternal(`${window.location.pathname}${routeHash(target)}`);
              else go(target);
            }}
          />
        </Col>
      </ScrollView>
    </Col>
  );
}
