import { allowlistForLine, accountFromLine, senderPermitted } from '../agents/map.js';
import { stationByName } from '../stations/registry.js';
import { registerApprovalHandler, setApprovalChat, startApprovals } from '../approvals/flow.js';
import { metroCall } from './ctx.js';
import { runApprovedCall } from './tool-dispatch.js';

const promptable = (line: string): boolean => {
  const station = stationByName(accountFromLine(line)?.station ?? '');
  return station !== undefined && station.hasAccounts && station.approvals !== false && station.messageVerbs.has('send');
};

export function startChannelApprovals(): () => void {
  registerApprovalHandler('channel', { execute: runApprovedCall });
  setApprovalChat({
    post: async (line, text) => {
      await metroCall(accountFromLine(line)?.station ?? '', 'send', { line, text });
    },
    promptable,
    replyCounts: (line, from, verified) =>
      promptable(line) && verified !== false && senderPermitted(allowlistForLine(line), from, verified),
  });
  return startApprovals();
}
