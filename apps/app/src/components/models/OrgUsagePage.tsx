import { type ReactNode } from 'react';
import { Groups } from '../ui/Group.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useDocumentTitle } from '../../lib/title.js';
import { GatewayUsage } from './GatewayUsage.js';

export function OrgUsagePage(): ReactNode {
  useDocumentTitle('Gateway usage');
  return (
    <Groups>
      <PageHeader title="Usage" subtitle="What every agent and access key spent on models through gateway.metro.box. Never what was asked or answered." />
      <GatewayUsage agent={null} />
    </Groups>
  );
}
