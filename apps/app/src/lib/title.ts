const SITE = 'Metro';

export const pageTitle = (page: string | null): string => (page === null || page === '' ? SITE : `${page} - ${SITE}`);

export const noteTitle = (page: string | null): string => pageTitle(page);

export function useDocumentTitle(page: string | null): void {
  noteTitle(page);
}
