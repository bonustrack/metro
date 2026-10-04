export const DELETE_WORD = 'delete';

export const confirmPrompt = (word: string): string => `Type ${word} to confirm.`;

export const confirmMatches = (typed: string, word: string): boolean => word !== '' && typed.trim() === word;
