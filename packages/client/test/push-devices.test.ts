import { beforeEach, describe, expect, test } from 'bun:test';
import { approvalLinkHash } from '../src/api/push-devices.js';
import { routeSelection } from '../src/route.js';
import { noteRoutedOrganization, routedOrganization } from '../src/auth/org-route.js';
import { clearAccount } from '../src/auth/account.js';

const ORG = 'org_01ABCDEFGHIJKLMNOPQRSTUVWX';
const AGENT = 'aB3dE6gH9jK';

beforeEach(() => {
  clearAccount();
  noteRoutedOrganization(null);
});

describe('a notification opens only a metro.box approval page', () => {
  test('the link mcp.metro.box sends opens that approval of that agent, in that organization', () => {
    const hash = approvalLinkHash(`https://metro.box/#/${ORG}/${AGENT}/approvals/abcde`);
    expect(hash).toBe(`#/${ORG}/${AGENT}/approvals/abcde`);
    expect(routeSelection(hash ?? '')).toEqual({ kind: 'approval', project: AGENT, id: 'abcde' });
    expect(routedOrganization()).toBe(ORG);
  });

  test('anything else is ignored', () => {
    const refused: unknown[] = [
      undefined,
      null,
      42,
      '',
      `http://metro.box/#/${ORG}/${AGENT}/approvals/abcde`,
      `https://metro.box.evil.example/#/${ORG}/${AGENT}/approvals/abcde`,
      `https://evil.example/https://metro.box/#/${ORG}/${AGENT}/approvals/abcde`,
      `https://user@metro.box/#/${ORG}/${AGENT}/approvals/abcde`,
      `https://metro.box/?x=1#/${ORG}/${AGENT}/approvals/abcde`,
      `https://metro.box/#/${ORG}/${AGENT}/approvals/abcdl`,
      `https://metro.box/#/${ORG}/${AGENT}/approvals/abcdef`,
      `https://metro.box/#/${ORG}/${AGENT}/approvals/abcde/more`,
      `https://metro.box/#/${ORG}/${AGENT}/settings`,
      `https://metro.box/#/stage-labs/${AGENT}/approvals/abcde`,
      `https://metro.box/#/${ORG}/-B3dE6gH9jK/approvals/abcde`,
      `https://metro.box/#/${ORG}/../approvals/abcde`,
      `javascript:alert(1)//https://metro.box/#/${ORG}/${AGENT}/approvals/abcde`,
      `metro://${ORG}/${AGENT}/approvals/abcde`,
    ];
    for (const link of refused) expect(approvalLinkHash(link)).toBeNull();
  });
});
