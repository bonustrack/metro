import { type ReactNode } from 'react';
import { opensElsewhere } from './link.js';
import { PageTitle } from './PageTitle.js';
import { routeHash } from '../route.js';
import { sectionOf } from './sections.js';
import { type Selection } from './selection.js';

interface SectionTabsProps {
  project: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

export function SectionTabs({ project, selection, onSelect }: SectionTabsProps): ReactNode {
  const section = sectionOf(selection.kind);
  const tabs = section?.tabs;
  if (section === undefined || tabs === undefined) return null;
  return (
    <header className="section-head">
    <PageTitle>{section.label}</PageTitle>
    <nav className="section-tabs" aria-label={section.label}>
      {tabs.map((tab) => {
        const target = tab.target(project);
        const href = routeHash(target);
        const current = tab.kinds.includes(selection.kind);
        return (
          <a
            key={tab.label}
            className={current ? 'section-tab is-current' : 'section-tab'}
            href={href}
            aria-current={current ? 'page' : undefined}
            target={tab.newTab === true ? '_blank' : undefined}
            rel={tab.newTab === true ? 'noopener' : undefined}
            onClick={(e) => {
              if (tab.newTab === true || opensElsewhere(e)) return;
              e.preventDefault();
              onSelect(target);
            }}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
    </header>
  );
}
