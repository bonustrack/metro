import { type ReactNode } from 'react';
import type { OrgModelConnection } from '@metro-labs/client/api/org-models';
import { USAGE_LIMIT, usageLabel } from '@metro-labs/client/api/model-usage';
import { windowLine } from '@metro-labs/client/api/usage';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { useGatewayWindows } from '../../lib/model-queries.js';
import { useNow } from '../../lib/use-now.js';

const percentOf = (used: number): string => `${String(Math.round(used * 100))}%`;

export function AccountLimits({ connection }: { connection: OrgModelConnection }): ReactNode {
  const now = useNow(60_000);
  const windows = useGatewayWindows(true).filter((w) => w.connection === connection.id);
  if (windows.length === 0) return null;
  return (
    <Group label="Limits" note="What the provider reported on its last answers through gateway.metro.box. Above 95% of a limit, the account is skipped until it resets.">
      {windows.map((w) => (
        <Item key={w.label} title={usageLabel(w.label, connection.provider)} subtitle={windowLine({ ...w, used: null }, now) || undefined} chevron={false}
          value={w.used === null ? undefined : percentOf(w.used)} valueTone={w.used !== null && w.used > USAGE_LIMIT ? 'danger' : 'link'} />
      ))}
    </Group>
  );
}
