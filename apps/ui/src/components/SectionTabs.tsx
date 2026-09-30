import { type ReactNode } from 'react';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { PageTitle } from './PageTitle.js';
import { routeHash } from '../route.js';
import { sectionOf } from './sections.js';
import { type Selection } from './selection.js';

const TAB_WIDTH = 150;

interface SectionTabsProps {
  project: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

export function SectionTabs({ project, selection, onSelect }: SectionTabsProps): ReactNode {
  const section = sectionOf(selection.kind);
  const tabs = section?.tabs;
  if (section === undefined || tabs === undefined) return null;
  const current = tabs.find((tab) => tab.kinds.includes(selection.kind));
  const track = { width: tabs.length * TAB_WIDTH };
  return (
    <header className="section-head">
      <PageTitle>{section.label}</PageTitle>
      <nav className="section-tabs" aria-label={section.label}>
        <div className="section-tabs-track" style={track}>
        <Tabs
          value={current?.label ?? ''}
          options={tabs.map((tab) => ({ value: tab.label, label: tab.label }))}
          onChange={(label) => {
            const tab = tabs.find((t) => t.label === label);
            if (tab === undefined) return;
            const target = tab.target(project);
            if (tab.newTab === true) window.open(routeHash(target), '_blank', 'noopener');
            else onSelect(target);
          }}
        />
        </div>
      </nav>
    </header>
  );
}
