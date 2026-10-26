import { type ReactNode } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Item } from '../ui/Item.js';
import { updateOffered, useMetroUpdate, versionFacts, type MetroUpdate } from '../MetroVersion.js';
import { shortVersion } from '../../lib/settings-values.js';
import { useTechnicalDetails } from '../../lib/technical.js';

type Facts = ReturnType<typeof versionFacts>;

function noteOf(u: MetroUpdate, facts: Facts, offered: boolean): { text: string; danger: boolean } {
  if (u.error !== null) return { text: u.error, danger: true };
  if (u.status !== null) return { text: u.status, danger: false };
  if (facts.restart && facts.installed !== null) return { text: `${shortVersion(facts.installed)} is installed. Restart to run it.`, danger: false };
  if (offered && u.release.data !== undefined) return { text: `${shortVersion(u.release.data.latest)} is ready`, danger: false };
  return { text: facts.modeStale ? 'Version not known right now' : facts.availability.label, danger: false };
}

function UpdateButton({ u }: { u: MetroUpdate }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return <Button size="sm" color="secondary" dark={dark} label={u.busy ? 'Updating…' : 'Update'} loading={u.busy} disabled={u.busy} onPress={u.update} />;
}

function CheckButton({ u }: { u: MetroUpdate }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const busy = u.busy || u.release.isFetching || u.mode.isFetching || u.check.isFetching;
  return <Button size="sm" color="secondary" dark={dark} label="Check for updates" disabled={busy} onPress={u.refresh} />;
}

export function VersionRow(): ReactNode {
  const u = useMetroUpdate();
  const technical = useTechnicalDetails();
  const facts = versionFacts(u);
  const offered = updateOffered(facts, u);
  const note = noteOf(u, facts, offered);
  const version = technical ? (facts.version ?? 'Unknown') : shortVersion(facts.version);
  const trailing = offered || u.busy ? <UpdateButton u={u} /> : <CheckButton u={u} />;
  const detail = u.check.isError ? 'Could not check the installed package version.' : undefined;
  return <Item title="Metro version" subtitle={note.text} subtitleTone={note.danger ? 'danger' : 'secondary'} detail={detail} value={version} trailing={trailing} chevron={false} />;
}
