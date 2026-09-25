import { type ReactNode } from 'react';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { ProviderLogo } from './ProviderLogo.js';
import { UsageRow } from './ModelUsage.js';
import { useModelName } from './AgentModel.js';
import { FactRow, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { PROVIDERS, type ModelSettings } from '../api/model.js';
import { routedConnection } from '../api/providers.js';
import { tallyLine } from '../api/usage.js';
import { whenLabel } from '../api/when.js';

const LOGO = 32;

function Usage({ settings }: { settings: ModelSettings }): ReactNode {
  const conn = routedConnection(settings);
  const usage = conn === undefined ? undefined : settings.usage[conn.id];
  if (usage === undefined) return null;
  return (
    <>
      {usage.windows.map((window) => (
        <UsageRow key={window.label} window={window} />
      ))}
      {usage.tally === null ? null : <FactRow label="Use since start" value={tallyLine(usage.tally)} />}
    </>
  );
}

function noteOf(settings: ModelSettings): string {
  const conn = routedConnection(settings);
  const served = settings.lastServed;
  return [conn?.label ?? 'Claude login of the server', served === null ? '' : `Last used ${whenLabel(served.at)}`].filter((x) => x !== '').join(' · ');
}

export function CurrentModel({ settings, onChange }: { settings: ModelSettings; onChange: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const conn = routedConnection(settings);
  const name = useModelName(conn);
  const note = noteOf(settings);
  return (
    <SettingsGroup title="In use">
      <SettingsSection title={name} note={note} leading={<ProviderLogo provider={PROVIDERS.find((p) => p.id === conn?.provider)} size={LOGO} />}>
        {settings.connections.length === 0 ? null : <Button size="sm" color="primary" dark={dark} label="Change model" onPress={onChange} />}
      </SettingsSection>
      {settings.reason === null ? null : (
        <div className="settings-pad">
          <Text size="sm" role="danger">
            {settings.reason}
          </Text>
        </div>
      )}
      <Usage settings={settings} />
    </SettingsGroup>
  );
}
