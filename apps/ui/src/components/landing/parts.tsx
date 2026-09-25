import { type ReactNode } from 'react';
import { Text } from '../ui.js';
import { useReveal } from './reveal.js';

export function Eyebrow({ children }: { children: ReactNode }): ReactNode {
  return <div className="lp-eyebrow">{children}</div>;
}

interface SectionProps {
  id?: string;
  index?: string;
  eyebrow: string;
  title: string;
  body?: string;
  children: ReactNode;
}

export function Section({ id, index, eyebrow, title, body, children }: SectionProps): ReactNode {
  const { ref, shown } = useReveal<HTMLElement>();
  return (
    <section id={id} ref={ref} className={`lp-section${shown ? ' is-shown' : ''}`}>
      <div className="lp-head">
        <Eyebrow>
          {index === undefined ? null : <span className="lp-index">{index}</span>}
          {eyebrow}
        </Eyebrow>
        <h2 className="lp-h2">{title}</h2>
        {body === undefined ? null : (
          <Text size="xl" role="secondary">
            {body}
          </Text>
        )}
      </div>
      {children}
    </section>
  );
}
