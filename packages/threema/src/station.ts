import type { Station, Verb } from '@metro-labs/core/stations/types';
import { groupFiles } from './groups.js';

export const threemaStation: Station = {
  name: 'threema',
  hasAccounts: true,
  hasTrain: true,
  messageVerbs: new Set<Verb>(['send', 'reply', 'react', 'unreact']),
  attachmentMode: 'canonical',
  forget: groupFiles.forget,
  forgetExcept: groupFiles.forgetExcept,
  tools: [],
};
