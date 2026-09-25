import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { Text } from '../ui.js';
import { FACTS } from './content.js';

const STATEMENT = 'Other AI tools read your data in their cloud. Your agent runs on its own server. Nothing passes through us.';

const WORDS = STATEMENT.split(' ');
const START = 0.85;
const END = 0.35;

function useWordsLit(): { ref: RefObject<HTMLParagraphElement | null>; lit: number } {
  const ref = useRef<HTMLParagraphElement>(null);
  const [lit, setLit] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const node = ref.current;
      if (node === null) return;
      const box = node.getBoundingClientRect();
      const view = window.innerHeight;
      const from = view * START;
      const to = view * END - box.height;
      const progress = Math.min(1, Math.max(0, (from - box.top) / (from - to)));
      setLit(Math.round(progress * WORDS.length));
    };
    const onScroll = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  return { ref, lit };
}

export function Manifesto(): ReactNode {
  const { ref, lit } = useWordsLit();
  return (
    <section className="lp-manifesto" aria-label="Why Metro">
      <p ref={ref} className="lp-manifesto-text">
        {WORDS.map((word, i) => (
          <span key={`${word}-${String(i)}`} className={i < lit ? 'is-lit' : undefined}>
            {`${word} `}
          </span>
        ))}
      </p>
      <div className="lp-facts-grid">
        {FACTS.map((fact) => (
          <div key={fact.value} className="lp-fact">
            <span className="lp-fact-value">{fact.value}</span>
            <Text size="sm" role="secondary">
              {fact.label}
            </Text>
          </div>
        ))}
      </div>
    </section>
  );
}
