import { useEffect, useRef } from 'react';
import { isInlineImage, pickedFile, type PickedFile } from './chat-files.js';

export type PickSource = 'photos' | 'files';

export const PICK_SOURCES: readonly PickSource[] = ['files'];

const fromFile = (file: File): PickedFile =>
  pickedFile({ name: file.name, type: file.type, size: file.size, preview: (type) => (isInlineImage(type) ? URL.createObjectURL(file) : null), body: () => Promise.resolve(file) });

export function pickChatFiles(): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []).map(fromFile));
    });
    input.addEventListener('cancel', () => {
      resolve([]);
    });
    input.click();
  });
}

export function releasePicked(file: PickedFile): void {
  if (file.preview !== null) URL.revokeObjectURL(file.preview);
}

export function usePastedFiles(enabled: boolean, onFiles: (files: PickedFile[]) => void): void {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    if (!enabled) return undefined;
    const paste = (event: ClipboardEvent): void => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) => isInlineImage(file.type));
      if (images.length === 0) return;
      event.preventDefault();
      latest.current(images.map(fromFile));
    };
    document.addEventListener('paste', paste);
    return () => {
      document.removeEventListener('paste', paste);
    };
  }, [enabled]);
}
