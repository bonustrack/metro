import { useEffect, useState } from 'react';

const DELAY_MS = 100;

export function useLoadingVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return visible;
}
