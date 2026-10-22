import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HttpError } from '@metro-labs/client/api/client';
import { launchServer, type LaunchOverview } from '@metro-labs/client/api/launch';
import { addRemoteAgent, setServerAvatar } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { launchRegions, regionName } from '@metro-labs/client/aws/regions';
import { useImagePicker } from '../AvatarPicker.js';
import { CopyBlock } from '../CopyBlock.js';
import { Loading } from '../Loading.js';
import { StateBlock } from '../ui/StateBlock.js';
import { LaunchError } from './LaunchError.js';
import { LaunchFrame, type LaunchKind, type LaunchStep } from './LaunchFrame.js';
import { ConfirmStep, KindStep, NameStep, PlaceStep, seedOf } from './LaunchSteps.js';
import { LaunchWatch, type LaunchSubject } from './LaunchWatch.js';
import { ADD_AGENT_ADMIN, cityOf, closestRegion, mayAddAgent, refusalOf } from '../../lib/launch-steps.js';
import { FocusFrame } from '../ui/FocusFrame.js';
import { queryError, refreshServers, useLaunchOverviewQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { go } from '../../lib/nav.js';

type Phase = { kind: Exclude<LaunchStep, 'kind'> } | { kind: 'watch'; subject: LaunchSubject } | { kind: 'refused'; message: string; status: number | null; region: string; at: Date };

const OFF = 'Launching is off here. Add your own server from the agent list instead.';
const OFF_IDENTITY = 'To turn it on, set the AWS and Tailscale secrets on this deployment.';

const timeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (at: Date): string => at.toTimeString().slice(0, 8);
const cityIn = (code: string): string => cityOf(regionName(code));

function Off({ text }: { text: string }): ReactNode {
  const organization = activeAccount()?.organization ?? null;
  return (
    <>
      <StateBlock icon="robot" title="Launching is off here" text={text} action={{ label: 'Back to your agents', onPress: () => { go({ kind: 'servers' }); } }} />
      {organization === null ? null : <CopyBlock label={OFF_IDENTITY} value={organization} />}
    </>
  );
}

function pictureFailure(err: unknown): string {
  const why = queryError(err, '').replace(/\.$/, '');
  return why === '' ? 'The picture did not upload.' : `The picture did not upload: ${why}.`;
}

function uploadPicture(serverId: string, avatar: string | null): Promise<string | null> {
  if (avatar === null) return Promise.resolve(null);
  return setServerAvatar(serverId, avatar).then(() => null, pictureFailure);
}

function startOf(launchedAt: string | null): number {
  const at = launchedAt === null ? NaN : Date.parse(launchedAt);
  return Number.isFinite(at) ? at : Date.now();
}

interface Named {
  name: string;
  setName: (name: string) => void;
  avatar: string | null;
  picker: ReturnType<typeof useImagePicker>;
}

function useNamed(): Named {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const picker = useImagePicker((next) => { setAvatar(next); return Promise.resolve(); });
  return { name, setName, avatar, picker };
}

function useLauncher(regions: string[], named: Named): {
  phase: Phase; setPhase: (phase: Phase) => void; name: string; setName: (name: string) => void; region: string; setRegion: (region: string) => void;
  avatar: string | null; picker: ReturnType<typeof useImagePicker>; busy: boolean; launch: (region: string) => void;
} {
  const client = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'name' });
  const { name, setName, avatar, picker } = named;
  const [region, setRegion] = useState(() => closestRegion(regions, timeZone()) ?? '');
  const [busy, setBusy] = useState(false);
  const launch = (where: string): void => {
    if (busy) return;
    const label = seedOf(name);
    setBusy(true);
    launchServer(label, where)
      .then(async (launched) => {
        const pictureError = await uploadPicture(launched.server.id, avatar);
        await refreshServers(client);
        const subject = { launched, name: launched.server.name ?? label, avatar: pictureError === null ? avatar : null, pictureError, place: cityIn(launched.region === '' ? where : launched.region), startedAt: startOf(launched.server.launchedAt) };
        setPhase({ kind: 'watch', subject });
      })
      .catch((err: unknown) => {
        setPhase({ kind: 'refused', message: queryError(err, 'The launch did not finish.'), status: err instanceof HttpError ? err.status : null, region: where, at: new Date() });
      })
      .finally(() => { setBusy(false); });
  };
  return { phase, setPhase, name, setName, region, setRegion, avatar, picker, busy, launch };
}

interface RefusedProps {
  name: string;
  message: string;
  status: number | null;
  region: string;
  at: Date;
  regions: string[];
  busy: boolean;
  onLaunch: (region: string) => void;
}

function Refused({ name, message, status, region, at, regions, busy, onLaunch }: RefusedProps): ReactNode {
  const failure = refusalOf(message, cityIn(region), status);
  const other = failure.elsewhere ? closestRegion(regions.filter((code) => code !== region), timeZone()) : null;
  const action = other === null
    ? { label: 'Try again', busy, onPress: () => { onLaunch(region); } }
    : { label: `Try again in ${cityIn(other)}`, note: 'The closest other place. Same size and price.', busy, onPress: () => { onLaunch(other); } };
  const lines = [`${clock(at)}  launch  ${region} · ${name}`, `${clock(at)}  error   ${message}`, ...(failure.refused ? [`${clock(at)}  launch  stopped, no server was started`] : [])];
  const back = { label: 'Back to your agents', onPress: () => { go({ kind: 'servers' }); } };
  return <LaunchError title={`${name} could not start`} reason={failure.text} action={failure.refused ? action : back} lines={lines} />;
}

const CHOOSING = new Set<Phase['kind']>(['name', 'place', 'launch']);

function stepBack(phase: Phase, onKind: () => void, setPhase: (phase: Phase) => void): ((next: LaunchStep) => void) | undefined {
  if (!CHOOSING.has(phase.kind)) return undefined;
  return (next) => {
    if (next === 'kind') onKind();
    else setPhase({ kind: next });
  };
}

function Flow({ overview, named, onKind }: { overview: LaunchOverview; named: Named; onKind: () => void }): ReactNode {
  const regions = launchRegions(overview.regions);
  const l = useLauncher(regions, named);
  const { phase } = l;
  const step: LaunchStep = phase.kind === 'name' || phase.kind === 'place' ? phase.kind : 'launch';
  const onStep = stepBack(phase, onKind, l.setPhase);
  const label = seedOf(l.name);
  return (
    <LaunchFrame step={step} onStep={onStep}>
      {phase.kind === 'name' ? <NameStep name={l.name} avatar={l.avatar} picker={l.picker} onName={l.setName} onNext={() => { l.setPhase({ kind: 'place' }); }} onBack={onKind} /> : null}
      {phase.kind === 'place' ? (
        <PlaceStep name={l.name} regions={regions} closest={closestRegion(regions, timeZone())} region={l.region} onRegion={l.setRegion} onNext={() => { l.setPhase({ kind: 'launch' }); }} onBack={() => { l.setPhase({ kind: 'name' }); }} />
      ) : null}
      {phase.kind === 'launch' ? <ConfirmStep name={l.name} avatar={l.avatar} region={l.region} busy={l.busy} onLaunch={() => { l.launch(l.region); }} onBack={() => { l.setPhase({ kind: 'place' }); }} /> : null}
      {phase.kind === 'watch' ? <LaunchWatch subject={phase.subject} /> : null}
      {phase.kind === 'refused' ? <Refused name={label} message={phase.message} status={phase.status} region={phase.region} at={phase.at} regions={regions} busy={l.busy} onLaunch={l.launch} /> : null}
    </LaunchFrame>
  );
}

function BoxLaunch({ named, onKind }: { named: Named; onKind: () => void }): ReactNode {
  const { data, error } = useLaunchOverviewQuery();
  const back = (next: LaunchStep): void => { if (next === 'kind') onKind(); };
  if (error !== null) return <LaunchFrame step="name" onStep={back}><Off text={queryError(error, OFF)} /></LaunchFrame>;
  if (data === undefined) return <LaunchFrame step="name" onStep={back}><Loading /></LaunchFrame>;
  if (!data.enabled) return <LaunchFrame step="name" onStep={back}><Off text={OFF} /></LaunchFrame>;
  return <Flow overview={data} named={named} onKind={onKind} />;
}

const REMOTE_NAME = 'You see this name on metro.box and in the activity. You can change it later.';

function RemoteCreate({ named, onKind }: { named: Named; onKind: () => void }): ReactNode {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = seedOf(named.name);
  const create = (): void => {
    if (busy || named.name.trim() === '') return;
    setBusy(true);
    setError(null);
    addRemoteAgent(named.name.trim())
      .then(async (server) => {
        await uploadPicture(server.id, named.avatar);
        await refreshServers(client);
        go({ kind: 'home', project: server.id });
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Metro could not create the agent.'));
        setBusy(false);
      });
  };
  const onStep = (next: LaunchStep): void => { if (next === 'kind') onKind(); };
  return (
    <LaunchFrame step="name" kind="remote" onStep={onStep}>
      <NameStep name={named.name} avatar={named.avatar} picker={named.picker} onName={named.setName} onNext={create} onBack={onKind} text={REMOTE_NAME} next={`Create ${label}`} busy={busy} error={error} />
    </LaunchFrame>
  );
}

function AdminsOnly(): ReactNode {
  return (
    <FocusFrame title="New agent" onClose={() => { go({ kind: 'servers' }); }}>
      <StateBlock icon="robot" title="Only an admin adds agents" text={ADD_AGENT_ADMIN} action={{ label: 'Back to your agents', onPress: () => { go({ kind: 'servers' }); } }} />
    </FocusFrame>
  );
}

function AdminLaunch(): ReactNode {
  const named = useNamed();
  const [kind, setKind] = useState<LaunchKind | null>(null);
  const [picked, setPicked] = useState<LaunchKind | null>(null);
  const choose = (): void => { setPicked(null); };
  if (picked === 'remote') return <RemoteCreate named={named} onKind={choose} />;
  if (picked === 'box') return <BoxLaunch named={named} onKind={choose} />;
  return (
    <LaunchFrame step="kind" kind={kind ?? 'box'}>
      <KindStep kind={kind} onKind={setKind} onNext={() => { setPicked(kind); }} />
    </LaunchFrame>
  );
}

export function LaunchFlow(): ReactNode {
  useDocumentTitle('New agent');
  return mayAddAgent(activeAccount()?.role) ? <AdminLaunch /> : <AdminsOnly />;
}
