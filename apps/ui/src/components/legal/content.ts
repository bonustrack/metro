import { TERMS } from './terms.js';
import { PRIVACY } from './privacy.js';

export const LEGAL_PAGES = {
  'terms-of-use': { title: 'Terms of use', text: TERMS },
  'privacy-policy': { title: 'Privacy policy', text: PRIVACY },
} as const;
