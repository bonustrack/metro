import { chatApprovals } from '@metro-labs/client/api/accounts';
import { useModeQuery } from './queries.js';

export const useChatApprovals = (): boolean => chatApprovals(useModeQuery().data?.version);
