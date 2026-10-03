import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { FactRow, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { fetchAwsCheck, type AwsCheck } from '../api/admin.js';
import { queryError } from '../api/queries.js';

const SIGNS_IN: Record<AwsCheck['signsInWith'], string> = {
  role: 'Its role through Fly, no access key',
  key: 'The access key of the IAM user metro',
  none: 'Nothing: AWS is not set up on this deployment',
};

const NOTE =
  "Checks Metro's own role against every server Metro launched, without switching to it. Once every server reads OK, unset the access key on Fly and Metro uses the role.";

function Results({ data }: { data: AwsCheck }): ReactNode {
  const { check } = data;
  if (check === null) return <FactRow label="Role" value="Not set (METRO_AWS_ROLE_ARN)" />;
  return (
    <>
      <FactRow label="Role" value={check.error ?? `${data.role ?? ''} in ${check.account ?? '?'}`} danger={check.error !== null} />
      {check.servers.map((s) => (
        <FactRow key={s.id} label={s.name ?? s.id} value={s.ok ? `OK, ${s.state ?? ''} · ${s.instanceId} · ${s.region}` : (s.error ?? 'Failed')} danger={!s.ok} />
      ))}
    </>
  );
}

export function AdminAws(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [round, setRound] = useState(0);
  const aws = useQuery({ queryKey: ['admin', 'aws', round], queryFn: fetchAwsCheck, enabled: round > 0, staleTime: Infinity, retry: false });
  return (
    <SettingsGroup title="AWS" note={NOTE}>
      {aws.data === undefined ? null : <FactRow label="Metro signs in with" value={SIGNS_IN[aws.data.signsInWith]} />}
      {aws.data === undefined ? null : <Results data={aws.data} />}
      <SettingsSection title="Check the role" note={aws.data?.check?.ok === true ? 'Every server reads OK through the role.' : undefined}>
        <Button
          size="md"
          color="secondary"
          dark={dark}
          label={round > 0 ? 'Check again' : 'Check'}
          loading={aws.isFetching}
          disabled={aws.isFetching}
          onPress={() => {
            setRound((n) => n + 1);
          }}
        />
      </SettingsSection>
      {aws.error === null ? null : (
        <div className="settings-pad">
          <Text size="2xs" role="danger">
            {queryError(aws.error, 'Could not check the role.')}
          </Text>
        </div>
      )}
    </SettingsGroup>
  );
}
