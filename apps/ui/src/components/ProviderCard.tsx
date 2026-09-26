import { type ReactNode } from 'react';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import { SettingsSection } from './SettingsSection.js';
import { useModelName } from './AgentModel.js';
import type { MenuItem } from './Dropdown.js';
import { PROVIDERS, type ConnectionRow, type ModelSettings } from '../api/model.js';
import { windowLine } from '../api/usage.js';
import { useClaudeLoginOf } from '../api/queries.js';

const LOGO = 24;

const usageLine = (settings: ModelSettings, connection: ConnectionRow): string | null => {
  const window = settings.usage[connection.id]?.windows[0];
  if (window === undefined) return null;
  return window.label === connection.model ? windowLine(window) : `${window.label} ${windowLine(window)}`;
};

interface ProviderRowProps {
  connection: ConnectionRow;
  settings: ModelSettings;
  items: MenuItem[];
  busy: boolean;
  onUse: () => void;
}

export function ProviderRow({ connection, settings, items, busy, onUse }: ProviderRowProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const model = useModelName(connection);
  const inUse = settings.route === connection.id;
  const note = [useClaudeLoginOf(connection), model, usageLine(settings, connection)].filter((part): part is string => part !== null && part !== '').join(' · ');
  return (
    <SettingsSection title={connection.label} note={note} leading={<ProviderLogo provider={PROVIDERS.find((p) => p.id === connection.provider)} size={LOGO} />}>
      <div className="provider-row-end">
        {inUse ? <span className="tag">In use</span> : <Button size="sm" color="secondary" dark={dark} label="Use" disabled={busy} onPress={onUse} />}
        <KebabMenu label={`${connection.label} menu`} items={items} />
      </div>
    </SettingsSection>
  );
}
