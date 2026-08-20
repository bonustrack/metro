import { useEffect } from 'react';

const SITE = 'Metro';

export function pageTitle(page: string | null): string {
  return page === null || page === '' ? SITE : `${page} - ${SITE}`;
}

export function useDocumentTitle(page: string | null): void {
  useEffect(() => {
    document.title = pageTitle(page);
  }, [page]);
}
