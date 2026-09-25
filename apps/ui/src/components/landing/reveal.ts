import { useEffect, useRef, useState, type RefObject } from 'react';

const THRESHOLD = 0.18;

export function useReveal<T extends Element>(): { ref: RefObject<T | null>; shown: boolean } {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShown(true);
        observer.disconnect();
      },
      { threshold: THRESHOLD },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, shown };
}

export function useScrolled(offset: number): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = (): void => {
      setScrolled(window.scrollY > offset);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, [offset]);
  return scrolled;
}
