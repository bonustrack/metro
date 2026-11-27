import { useEffect } from 'react';

export function useStickToBottom(change: unknown): void {
  useEffect(() => undefined, [change]);
}
