import { type ReactNode } from 'react';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { ProviderLogo } from './ProviderLogo.js';
import { UsageRow, UsageUpdateHint } from './ModelUsage.js';
import { useModelName } from './AgentModel.js';
import { FactRow, SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { holdLine, PROVIDERS, type ModelSettings } from '@metro-labs/client/api/model';
import { routedConnection, routedUsage } from '@metro-labs/client/api/providers';
import { tallyLine } from '@metro-labs/client/api/usage';
import { whenLabel } from '@metro-labs/client/api/when';
import { useAccountOf } from '../lib/queries.js';

const LOGO = 32;

function Usage({ settings }: { settings: ModelSettings }): ReactNode {
  const usage = routedUsage(settings);
  if (usage === undefined) return <UsageUpdateHint pad />;
  return (
    <>
      {usage.windows.map((window) => (
        <UsageRow key={window.label} window={window} />
      ))}
      {usage.tally === null ? null : <FactRow label="Use since start" value={tallyLine(usage.tally)} />}
    </>
  );
}

function noteOf(settings: ModelSettings, login: string | null): string {
  const conn = routedConnection(settings);
  const served = settings.lastServed;
  return [conn?.label ?? 'Claude login of the server', login ?? '', served === null ? '' : `Last used ${whenLabel(served.at)}`].filter((x) => x !== '').join(' · ');
}

function FallbackInUse({ settings }: { settings: ModelSettings }): ReactNode {
  const at = settings.chain.findIndex((row) => row.active);
  const active = settings.chain[at];
  const conn = settings.connections.find((c) => c.id === active?.connection);
  const name = useModelName(conn, active?.model);
  const hold = settings.chain[0]?.hold ?? null;
  if (at <= 0 || conn === undefined) return null;
  return (
    <SettingsPad>
      <Text size="2xs" role="danger">
        {`${hold === null ? 'Over its limit' : `Over its limit (${holdLine(hold)})`}. Requests now go to the fallback ${name} on ${conn.label}.`}
      </Text>
    </SettingsPad>
  );
}

export function CurrentModel({ settings, onChange }: { settings: ModelSettings; onChange: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const conn = routedConnection(settings);
  const name = useModelName(conn);
  const note = noteOf(settings, useAccountOf(conn));
  return (
    <SettingsGroup title="In use">
      <SettingsSection title={name} note={note} leading={<ProviderLogo provider={PROVIDERS.find((p) => p.id === conn?.provider)} size={LOGO} />}>
        {settings.connections.length === 0 ? null : <Button size="md" color="primary" dark={dark} label="Change model" onPress={onChange} />}
      </SettingsSection>
      {settings.reason === null ? null : (
        <SettingsPad>
          <Text size="2xs" role="danger">
            {settings.reason}
          </Text>
        </SettingsPad>
      )}
      <FallbackInUse settings={settings} />
      <Usage settings={settings} />
    </SettingsGroup>
  );
}
