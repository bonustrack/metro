import { useEffect, useState } from 'react';

export function useNow(interval = 1_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, interval);
    return () => { clearInterval(timer); };
  }, [interval]);
  return now;
}
