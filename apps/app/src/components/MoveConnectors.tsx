import { useState, type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { fetchMigrationPreview, type MigrationIssue, type MigrationPlan } from '@metro-labs/client/api/connector-migration';
import { ACCESS_LABEL, type ToolPolicy } from '@metro-labs/client/api/policy';
import { routeHash } from '@metro-labs/client/route';
import { useConnectorScope } from '../lib/org-connector-queries.js';
import { MIGRATION_PREVIEW_QUERY } from '../lib/migration-preview-query.js';
import { queryError, useBoxQuery } from '../lib/queries.js';
import { Loading } from './Loading.js';
import { Modal } from './Modal.js';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { TextLink } from './TextLink.js';

const ISSUES: Record<MigrationIssue, string> = {
  invalid_config: 'Blocked: these local settings could not be safely interpreted. Fix them locally before planning a move.',
  unsupported_url: 'Blocked: organization connectors need a public HTTPS server. This local address is not eligible.',
  custom_policy: 'Blocked: organization setup cannot preserve all these permission rules yet. Do not replace them with a read-only switch.',
  oauth_sign_in: 'Needs a fresh organization sign-in. Saved OAuth tokens will not be copied or refreshed by this preview.',
  header_reentry: 'Needs a key entered separately in organization setup. This preview never copies or displays the saved key.',
};

function Policy({ policy }: { policy: ToolPolicy }): ReactNode {
  return <Col gap={4}>
    <Text size="2xs">{`Current permissions: read ${ACCESS_LABEL[policy.read ?? 'allow'].toLowerCase()}, write ${ACCESS_LABEL[policy.write ?? 'allow'].toLowerCase()}.`}</Text>
    {Object.entries(policy.tools ?? {}).map(([name, access]) => <Text key={name} size="2xs" role="secondary">{`${name}: ${ACCESS_LABEL[access]}`}</Text>)}
  </Col>;
}

function PreviewRow({ row }: { row: MigrationPlan['rows'][number] }): ReactNode {
  const source = row.source;
  return <SettingsPad>
    <Text size="xs" weight="semibold">{source.name}</Text>
    <Text size="2xs" role="secondary">{source.origin ?? 'Address withheld'}</Text>
    <Policy policy={source.policy} />
    {source.issues.map((issue) => <Text key={issue} size="2xs" role={issue === 'invalid_config' || issue === 'unsupported_url' || issue === 'custom_policy' ? 'danger' : 'secondary'}>{ISSUES[issue]}</Text>)}
    {row.conflicts.map((conflict) => <Text key={conflict.id} size="2xs" role="danger">
      {`${conflict.kind === 'name' ? 'Name conflict' : 'Possible duplicate service'}: ${conflict.name} already exists in the organization${conflict.assigned ? ' and is assigned to this agent' : ''}. Review it; nothing will be merged or overwritten.`}
    </Text>)}
    {source.issues.length === 0 && row.conflicts.length === 0 ? <Text size="2xs" role="secondary">No local blocker found. Network reachability, sign-in and a safe cutover are still unverified.</Text> : null}
  </SettingsPad>;
}

function Preview({ plan }: { plan: MigrationPlan }): ReactNode {
  if (!plan.preview.enabled) return <Text size="2xs" role="secondary">Migration preview is off on this agent. It uses the existing organization connector sync switch, which also starts credential delivery and must stay off until a pilot is approved. The preview did not read or change local connector settings.</Text>;
  return <Col gap={16}>
    <Text size="2xs" role="secondary">Preview only. No connectors, credentials, permissions or assignments have changed. Closing this preview needs no rollback.</Text>
    <Text size="2xs">{plan.preview.enrolled ? `Local enrollment names this agent (${plan.preview.agentId ?? ''}). Intended assignment: only this agent, after API enrollment is verified. Nothing is assigned here.` : 'This agent is not enrolled in its current organization. Enrollment is required before a future move.'}</Text>
    {!plan.preview.liveEnabled ? <Text size="2xs" role="secondary">Organization tools are not enabled on this agent. A matching Metro version and an approved pilot are still required.</Text> : null}
    <Text size="2xs" role="secondary">This checks saved settings and current organization metadata only. It does not contact connector servers. Same-service matches are warnings, not proof of the same account; different names or addresses can still hide duplicates.</Text>
    {plan.rows.length === 0 ? <Text size="2xs">No local connector to move.</Text> : <SettingsGroup>{plan.rows.map((row) => <PreviewRow key={row.source.id} row={row} />)}</SettingsGroup>}
    <Text size="2xs" role="secondary">A move is not available yet. Keep local connectors intact. Creating and assigning an organization copy now would leave both tool servers active. A safe cutover must retire the old relay and keep a recovery record first.</Text>
    <Text size="2xs" role="secondary">For OAuth, a provider can invalidate an older login even after a fresh sign-in. A later rollback may require signing in locally again; restoring old tokens is not a guaranteed recovery.</Text>
    <TextLink to={routeHash({ kind: 'org-connectors' })}>View organization connectors</TextLink>
  </Col>;
}

function MigrationDialog({ scope, onClose }: { scope: number; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const query = useBoxQuery(['connectors', 'migration-preview', String(scope)], fetchMigrationPreview, MIGRATION_PREVIEW_QUERY);
  return <Modal title="Migration preview" open onClose={onClose}>
    <Col gap={16}>
      {query.isPending ? <Loading /> : null}
      {query.error !== null ? <Text size="2xs" role="danger">{queryError(query.error, 'Could not check the migration. Nothing was changed.')}</Text> : null}
      {query.error === null && query.data !== undefined ? <Preview plan={query.data} /> : null}
      <Button color="secondary" dark={dark} label="Close preview" onPress={onClose} />
    </Col>
  </Modal>;
}

function MoveButton({ scope }: { scope: number }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [open, setOpen] = useState(false);
  return <>
    <Button color="secondary" dark={dark} label="Move to organization" onPress={() => { setOpen(true); }} />
    {open ? <MigrationDialog scope={scope} onClose={() => { setOpen(false); }} /> : null}
  </>;
}

export function MoveConnectors(): ReactNode {
  const scope = useConnectorScope();
  if (activeAccount()?.role !== 'admin') return null;
  return <MoveButton key={`${String(scope)}:${daemonBase()}`} scope={scope} />;
}
