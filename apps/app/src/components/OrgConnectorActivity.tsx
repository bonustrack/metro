import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { orgEventText, type OrgConnectorEvent } from '@metro-labs/client/api/org-connectors';
import { serverLabel } from '@metro-labs/client/api/servers';
import { whenLabel } from '@metro-labs/client/api/when';
import { EmptyCard, SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { queryError, useServersQuery } from '../lib/queries.js';
import { useOrgEventsQuery } from '../lib/org-connector-queries.js';
import { logError } from '../lib/log.js';

const TITLE = 'Activity';
const NOTE = 'Who added, changed, signed in or gave a connector to an agent, newest first. Secrets never appear here.';

function useAgentNames(): (id: string) => string | null {
  const servers = useServersQuery().data ?? [];
  return (id) => {
    const found = servers.find((server) => server.id === id);
    return found === undefined ? null : serverLabel(found);
  };
}

function EventRow({ event, names }: { event: OrgConnectorEvent; names: (id: string) => string | null }): ReactNode {
  return (
    <SettingsSection title={orgEventText(event, names)} sub>
      <Text size="2xs" role="secondary" numberOfLines={1}>
        {whenLabel(event.at)}
      </Text>
    </SettingsSection>
  );
}

export function OrgConnectorActivity({ connector }: { connector: string | null }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const names = useAgentNames();
  const query = useOrgEventsQuery(connector);
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];
  if (query.error !== null) return <EmptyCard text={queryError(query.error, 'Could not load the activity.')} />;
  if (query.data === undefined) return null;
  if (events.length === 0)
    return (
      <SettingsGroup title={TITLE} note={NOTE}>
        <SettingsPad>
          <Text size="2xs" role="secondary">Nothing yet.</Text>
        </SettingsPad>
      </SettingsGroup>
    );
  return (
    <SettingsGroup title={TITLE} note={NOTE}>
      {events.map((event) => (
        <EventRow key={event.id} event={event} names={names} />
      ))}
      {query.hasNextPage ? (
        <SettingsPad>
          <Row>
            <Button size="md" color="secondary" dark={dark} label="Show older" loading={query.isFetchingNextPage} disabled={query.isFetchingNextPage} onPress={() => { query.fetchNextPage().catch(logError('org-connector-activity')); }} />
          </Row>
        </SettingsPad>
      ) : null}
    </SettingsGroup>
  );
}
