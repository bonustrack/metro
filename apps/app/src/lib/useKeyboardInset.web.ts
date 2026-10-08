import { useEffect, useState } from 'react';

const keyboardInset = (): number => {
  const viewport = window.visualViewport;
  return viewport === null ? 0 : Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
};

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(keyboardInset);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = (): void => { setInset(keyboardInset()); };
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return inset;
}
