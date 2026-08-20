import { useEffect, useState } from 'react';

const NARROW_QUERY = '(max-width: 1011px)';

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => {
      setNarrow(mq.matches);
    };
    mq.addEventListener('change', onChange);
    onChange();
    return () => {
      mq.removeEventListener('change', onChange);
    };
  }, []);
  return narrow;
}
