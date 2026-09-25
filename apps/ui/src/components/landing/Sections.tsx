import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { Text } from '../ui.js';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { PARTS, PILLARS, type Part } from './content.js';
import { Section } from './parts.js';
import { useReveal } from './reveal.js';
import { ControlDemo } from './ControlDemo.js';

function PartCard({ part, index }: { part: Part; index: number }): ReactNode {
  return (
    <div className={`lp-part lp-rise lp-beat-${String(index)}`}>
      <div className="lp-part-art" aria-hidden="true">
        {part.items.map((item) => (
          <span key={item.name} className="lp-part-icon">
            <ConnectorFavicon name={item.name} url={item.url} size={36} />
          </span>
        ))}
      </div>
      <span className="lp-part-kind">{part.kind}</span>
      <span className="lp-part-title">{part.title}</span>
      <Text size="xl" role="secondary">
        {part.body}
      </Text>
    </div>
  );
}

export function Parts(): ReactNode {
  return (
    <Section
      id="parts"
      index="01"
      eyebrow="How it works"
      title="Three things, all under your control."
      body="Channels are where your team talks to your agent. Connectors are the tools it may use. The model is what it thinks with. Each one goes through your server."
    >
      <div className="lp-parts">
        {PARTS.map((part, i) => (
          <PartCard key={part.kind} part={part} index={i} />
        ))}
      </div>
    </Section>
  );
}

function useActiveRow(count: number): { listRef: RefObject<HTMLUListElement | null>; active: number } {
  const listRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const list = listRef.current;
    if (list === null || typeof IntersectionObserver === 'undefined') return;
    const rows = Array.from(list.children);
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(rows.indexOf(entry.target));
        });
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    rows.forEach((row) => {
      observer.observe(row);
    });
    return () => {
      observer.disconnect();
    };
  }, [count]);
  return { listRef, active };
}

export function Privacy(): ReactNode {
  const { ref, shown } = useReveal<HTMLElement>();
  const { listRef, active } = useActiveRow(PILLARS.length);
  return (
    <section id="privacy" ref={ref} className={`lp-section lp-values${shown ? ' is-shown' : ''}`}>
      <div className="lp-values-side">
        <span className="lp-eyebrow">
          <span className="lp-index">02</span>
          Privacy
        </span>
        <h2 className="lp-h2">Your AI agent belongs in your hands.</h2>
        <Text size="xl" role="secondary">
          Most AI tools send your conversations through someone else’s cloud. Metro keeps the whole path on a server that belongs to you.
        </Text>
      </div>
      <ul ref={listRef} className="lp-values-list">
        {PILLARS.map((pillar, i) => (
          <li key={pillar.title} className={`lp-value${i === active ? ' is-active' : ''}`}>
            <span className="lp-value-n">{String(i + 1).padStart(2, '0')}</span>
            <span className="lp-value-main">
              <span className="lp-value-title">{pillar.title}</span>
              <span className="lp-value-body">{pillar.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Control(): ReactNode {
  return (
    <Section
      id="control"
      index="03"
      eyebrow="Control"
      title="You decide what your agent may do."
      body="Every channel and every connector has a rule for each tool. Try it: change a rule and see what your agent may do."
    >
      <ControlDemo />
    </Section>
  );
}
