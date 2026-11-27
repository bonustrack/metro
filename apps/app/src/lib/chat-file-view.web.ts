import { useEffect, useState } from 'react';
import type { ChatFile } from '@metro-labs/core/chat';

interface Shown {
  blob: Blob;
  uri: string | null;
}

const KEEP_LINK_MS = 60_000;

export function useBlobUri(blob: Blob | undefined): string | null | undefined {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    if (blob === undefined) return undefined;
    const uri = URL.createObjectURL(blob);
    setShown({ blob, uri });
    return () => {
      URL.revokeObjectURL(uri);
    };
  }, [blob]);
  return shown !== null && shown.blob === blob ? shown.uri : undefined;
}

export function saveChatFile(blob: Blob, file: ChatFile): Promise<void> {
  const uri = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = uri;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(uri);
  }, KEEP_LINK_MS);
  return Promise.resolve();
}
