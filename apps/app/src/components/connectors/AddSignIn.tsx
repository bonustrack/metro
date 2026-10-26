import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pressable, StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { addOrgConnector, orgConnectorCallbackUrl, type NewOrgConnector } from '@metro-labs/client/api/org-connectors';
import { FormField } from '../FormField.js';
import { Icon } from '../Icon.js';
import { PublicOAuthResource } from '../PublicOAuthResource.js';
import { inNewTab } from '../sign-in-tab.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { Actions } from '../ui/Actions.js';
import { FocusIntro } from '../ui/FocusFrame.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { nameFromAddress } from '../../lib/connector-address.js';
import { logError } from '../../lib/log.js';
import { goExternal } from '../../lib/open.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';

export interface Added {
  id: string;
  name: string;
  signingIn: boolean;
  link: string | null;
}

type Mode = 'oauth' | 'key';

interface Fields {
  name: string;
  header: string;
  key: string;
  clientId: string;
  clientSecret: string;
  resource: string;
}

const RADIO = 22;
const DOT = 10;
const styles = StyleSheet.create({
  radio: { width: RADIO, height: RADIO, borderRadius: RADIO / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});

function Radio({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  const ring = StyleSheet.flatten([styles.radio, { borderColor: on ? palette.link : palette.sub }]);
  return <View style={ring}>{on ? <View style={StyleSheet.flatten([styles.dot, { backgroundColor: palette.link }])} /> : null}</View>;
}

function Advanced({ mode, fields, set, busy }: { mode: Mode; fields: Fields; set: (key: keyof Fields) => (value: string) => void; busy: boolean }): ReactNode {
  const palette = useKitPalette();
  const [open, setOpen] = useState(false);
  return (
    <Column gap={12}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen(!open); }}>
        <Row align="center" justify="spaceBetween" gap={12} padding={{ y: 8 }}>
          <Column gap={2}>
            <Text size="md">Advanced</Text>
            <Text size="xs" color="secondary">{mode === 'key' ? 'Name and the header for the key' : 'Name and the app for the sign-in'}</Text>
          </Column>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.md} color={palette.sub} />
        </Row>
      </Pressable>
      {open ? (
        <Column gap={10}>
          <FormField label="Name" name="connector-name" value={fields.name} placeholder="Notion" disabled={busy} onChangeText={set('name')} />
          {mode === 'key' ? <FormField label="Header" name="connector-header" value={fields.header} placeholder="Authorization" disabled={busy} onChangeText={set('header')} /> : null}
          {mode === 'oauth' ? (
            <>
              <Text size="xs" color="secondary">{`For servers like Microsoft 365 only: register an app with the address ${orgConnectorCallbackUrl()} and paste its client id.`}</Text>
              <FormField label="Client ID (optional)" name="connector-client-id" value={fields.clientId} placeholder="00000000-0000-0000-0000-000000000000" disabled={busy} onChangeText={set('clientId')} />
              <FormField label="Client secret (optional)" name="connector-client-secret" value={fields.clientSecret} placeholder="" variant="obscured" disabled={busy} onChangeText={set('clientSecret')} />
              <PublicOAuthResource value={fields.resource} disabled={busy} onChange={set('resource')} />
            </>
          ) : null}
        </Column>
      ) : null}
    </Column>
  );
}

const NO_SIGN_IN = { header: '', value: '', clientId: '', clientSecret: '' };

function signInPart(mode: Mode, fields: Fields): Omit<NewOrgConnector, 'name' | 'url'> {
  if (mode === 'key') return { ...NO_SIGN_IN, header: fields.header.trim() || 'Authorization', value: fields.key };
  const resource = fields.resource.trim() === '' ? {} : { oauthResource: fields.resource };
  return { ...NO_SIGN_IN, clientId: fields.clientId, clientSecret: fields.clientSecret, ...resource };
}

function payload(url: string, mode: Mode, fields: Fields): NewOrgConnector {
  return { name: fields.name.trim() === '' ? nameFromAddress(url) : fields.name, url, ...signInPart(mode, fields) };
}

function useAdd(url: string, onAdded: (added: Added) => void): { busy: boolean; error: string | null; add: (mode: Mode, fields: Fields) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = (mode: Mode, fields: Fields): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let blocked: string | null = null;
    const begin = (): ReturnType<typeof addOrgConnector> => addOrgConnector(payload(url, mode, fields));
    const request = mode === 'oauth' ? inNewTab(begin, (result) => (result.kind === 'oauth' ? result.authorizeUrl : null), (link) => { blocked = link; }) : begin();
    request
      .then(async (result) => {
        await refreshOrgConnectors(client).catch(logError('org-connectors'));
        if (result.kind === 'oauth' && mode === 'key') {
          goExternal(result.authorizeUrl);
          return;
        }
        onAdded({ id: result.connector.id, name: result.connector.name, signingIn: result.kind === 'oauth', link: blocked });
      })
      .catch((err: unknown) => { setError(queryError(err, 'Could not add the connector.')); })
      .finally(() => { setBusy(false); });
  };
  return { busy, error, add };
}

export function SignInStep({ url, onBack, onAdded, onCancel }: { url: string; onBack: () => void; onAdded: (added: Added) => void; onCancel: () => void }): ReactNode {
  const app = nameFromAddress(url) || 'the service';
  const [mode, setMode] = useState<Mode>('oauth');
  const [fields, setFields] = useState<Fields>({ name: nameFromAddress(url), header: 'Authorization', key: '', clientId: '', clientSecret: '', resource: '' });
  const set = (key: keyof Fields) => (value: string): void => { setFields((prev) => ({ ...prev, [key]: value })); };
  const adding = useAdd(url, onAdded);
  const ready = mode === 'oauth' || fields.key.trim() !== '';
  const submit = (): void => { if (ready) adding.add(mode, fields); };
  return (
    <>
      <FocusIntro title={`Connect ${app}`} text="Choose how Metro signs in. One sign-in serves every agent." />
      <Group label="Address">
        <Item title={url} subtitle="Change it if this is not the right server" onPress={adding.busy ? undefined : onBack} />
      </Group>
      <Group label="How it signs in">
        <Item title={`Sign in with ${app}`} subtitle="Recommended. One account for the whole organization." leading={<Radio on={mode === 'oauth'} />} chevron={false} onPress={() => { setMode('oauth'); }} />
        <Item title="Use a key" subtitle={`Paste an API key or a token from ${app}.`} leading={<Radio on={mode === 'key'} />} chevron={false} onPress={() => { setMode('key'); }} />
      </Group>
      {mode === 'key' ? <FormField label="Key" name="connector-key" value={fields.key} placeholder="Bearer sk-…" variant="obscured" disabled={adding.busy} onChangeText={set('key')} onSubmit={submit} /> : null}
      <Advanced mode={mode} fields={fields} set={set} busy={adding.busy} />
      <Actions note="Next, you choose which agents get it." error={adding.error} cancel={{ onPress: onCancel, disabled: adding.busy }}
        main={{ label: mode === 'oauth' ? `Sign in with ${app}` : `Add ${app}`, busy: adding.busy, disabled: !ready, onPress: submit }} />
    </>
  );
}
