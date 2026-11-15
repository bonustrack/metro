import { describe, expect, test } from 'bun:test';
import { connectorOfKey } from '../src/api/connector-key.ts';
import { approvalCard } from '../src/api/approval-card.ts';
import { approvalOf } from '../src/api/approvals.ts';

const EMMA = 'agntEmma001';
const LISA = 'agntLisa001';

const connector = (id: string, name: string, agents: string[]) => ({ id, name, url: `https://${id}.example.com/mcp`, agents: agents.map((agent) => ({ id: agent })) });

const GMAIL = connector('conn0000002', 'Gmail fabien@bonustrack.co', [EMMA, LISA]);
const NOTION = connector('conn0000001', 'Notion', [EMMA]);
const NOTION_TEAM = connector('conn0000003', 'Notion', [EMMA, LISA]);
const SLACK = connector('conn0000004', 'Slack', [LISA]);
const LIST = [GMAIL, NOTION, NOTION_TEAM, SLACK];

describe('a connector key on an approval names its connector', () => {
  test('the key mcp.metro.box gives in the tool name finds the connector it was made from', () => {
    const asked = approvalOf({ id: 'abcde', tool: 'gmail-fabien-bonustrack-co.create_draft', preview: '{"to":"wan@mcigroup.ch"}', line: '' });
    if (asked === null) throw new Error('not an approval');
    const key = approvalCard(asked).connector ?? '';
    expect(key).toBe('gmail-fabien-bonustrack-co');
    expect(connectorOfKey(LIST, EMMA, key)).toBe(GMAIL);
  });

  test('keys are counted over the connectors of that agent only, as mcp.metro.box counts them', () => {
    expect(connectorOfKey(LIST, EMMA, 'notion')).toBe(NOTION);
    expect(connectorOfKey(LIST, EMMA, 'notion-2')).toBe(NOTION_TEAM);
    expect(connectorOfKey(LIST, LISA, 'notion')).toBe(NOTION_TEAM);
    expect(connectorOfKey(LIST, LISA, 'notion-2')).toBeUndefined();
  });

  test('a key with no connector of this agent behind it finds nothing', () => {
    expect(connectorOfKey(LIST, EMMA, 'slack')).toBeUndefined();
    expect(connectorOfKey(LIST, 'agntNobody1', 'gmail-fabien-bonustrack-co')).toBeUndefined();
    expect(connectorOfKey([], EMMA, 'notion')).toBeUndefined();
  });
});
