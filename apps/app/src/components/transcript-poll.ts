import type { TranscriptPage } from '@metro-labs/client/api/claude';

export function pollTranscript(
  offset: number,
  read: (offset: number) => Promise<TranscriptPage>,
  append: (page: TranscriptPage) => void,
  failed: (err: unknown) => void,
  interval = 4_000,
): () => void {
  let cursor = offset;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = (): void => {
    let delay = interval;
    read(cursor)
      .then((page) => {
        if (cancelled) return;
        cursor = page.next ?? page.total;
        delay = page.next === null ? interval : 0;
        append(page);
      })
      .catch((err: unknown) => {
        if (!cancelled) failed(err);
      })
      .finally(() => {
        if (!cancelled) timer = setTimeout(poll, delay);
      });
  };
  timer = setTimeout(poll, interval);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
