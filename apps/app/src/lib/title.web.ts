import { useEffect } from 'react';

const SITE = 'Metro';

export const pageTitle = (page: string | null): string => (page === null || page === '' ? SITE : `${page} - ${SITE}`);

export function noteTitle(page: string | null): string {
  document.title = pageTitle(page);
  return document.title;
}

export function useDocumentTitle(page: string | null): void {
  useEffect(() => {
    noteTitle(page);
  }, [page]);
}
