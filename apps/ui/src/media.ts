import { useEffect, useState } from 'react';

const NARROW_QUERY = '(max-width: 1011px)';
const TOUCH_QUERY = '(pointer: coarse)';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (): void => {
      setMatches(mq.matches);
    };
    mq.addEventListener('change', onChange);
    onChange();
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, [query]);
  return matches;
}

export function useIsNarrow(): boolean {
  return useMedia(NARROW_QUERY);
}

export function useIsTouch(): boolean {
  return useMedia(TOUCH_QUERY);
}
