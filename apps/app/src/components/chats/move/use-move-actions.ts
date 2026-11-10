import { useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { setAccountEnabled } from '@metro-labs/client/api/attach';
import { heldBy, MAIL_EVENT, connectorNameFor } from '@metro-labs/client/api/mail-move';
import { addOrgConnector, assignOrgConnector, setConnectorAgentEvents, setOrgConnectorAgentPolicy, signInOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { inNewTab } from '../../sign-in-tab.js';
import { withEvent } from '../../../lib/connector-events.js';
import { logError } from '../../../lib/log.js';
import { failureText, pendingNow, type ActionId, type MoveAction } from '../../../lib/mail-move.js';
import { refreshOrgConnectors } from '../../../lib/org-connector-queries.js';
import { queryError, refresh } from '../../../lib/queries.js';
import type { MailMove } from '../../../lib/use-mail-move.js';

export interface MoveIds {
  station: string;
  accountId: string;
  boxAgentId: string;
  serverId: string;
  mailbox: string;
}

async function reload(client: QueryClient): Promise<void> {
  await Promise.all([refreshOrgConnectors(client), refresh(client, 'stations')]);
}

export interface SignIn {
  busy: boolean;
  error: string | null;
  link: string | null;
  start: () => void;
}

const NO_KEY = { header: '', value: '', clientId: '', clientSecret: '' };

export function useSignIn(move: MailMove, ids: MoveIds): SignIn {
  const client = useQueryClient();
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const begin = async (): Promise<string | null> => {
    if (move.target !== null) return signInOrgConnector(move.target.connector.id);
    const added = await addOrgConnector({ ...NO_KEY, name: connectorNameFor(ids.mailbox), url: move.server });
    return added.kind === 'oauth' ? added.authorizeUrl : null;
  };
  const start = (): void => {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    setLink(null);
    inNewTab(begin, (url) => url, setLink)
      .then(() => { move.noteSignIn(); })
      .catch((err: unknown) => { setError(queryError(err, 'Could not start the sign-in.')); })
      .then(() => refreshOrgConnectors(client))
      .catch(logError('mail-move'))
      .finally(() => {
        starting.current = false;
        setBusy(false);
      });
  };
  return { busy, error, link, start };
}

type ConnectorAction = Exclude<ActionId, 'channel'>;

const CONNECTOR_RUN: Record<ConnectorAction, (connector: OrgConnector, move: MailMove, ids: MoveIds) => Promise<OrgConnector>> = {
  assign: (connector, _move, ids) => assignOrgConnector(connector.id, ids.serverId),
  rules: (connector, move, ids) => setOrgConnectorAgentPolicy(connector.id, ids.serverId, move.plan.policy),
  senders: (connector, move, ids) => setConnectorAgentEvents(connector.id, ids.serverId, { senders: move.plan.senders.senders }),
  event: (connector, _move, ids) => setConnectorAgentEvents(connector.id, ids.serverId, { events: withEvent(heldBy(connector, ids.serverId)?.events ?? [], MAIL_EVENT, true) }),
};

export interface Apply {
  running: ActionId | null;
  error: string | null;
  applied: boolean;
  run: () => void;
}

interface Progress {
  at: ActionId | null;
  done: number;
}

async function runAll(pending: readonly MoveAction[], move: MailMove, ids: MoveIds, progress: Progress, onStep: (id: ActionId) => void): Promise<void> {
  let connector = move.target?.connector;
  if (connector === undefined) throw new Error('The connector is gone. Start again.');
  for (const action of pending) {
    progress.at = action.id;
    onStep(action.id);
    if (action.id === 'channel') await setAccountEnabled(ids.boxAgentId, ids.station, ids.accountId, false);
    else connector = await CONNECTOR_RUN[action.id](connector, move, ids);
    progress.done += 1;
  }
}

export function useApply(move: MailMove, ids: MoveIds): Apply {
  const client = useQueryClient();
  const busy = useRef(false);
  const [running, setRunning] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const run = (): void => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    const pending = pendingNow(move.actions, move.plan);
    const progress: Progress = { at: null, done: move.actions.filter((action) => action.done).length };
    runAll(pending, move, ids, progress, setRunning)
      .then(() => { setApplied(true); })
      .catch((err: unknown) => { setError(progress.at === null ? queryError(err, 'Could not start.') : failureText(progress.at, queryError(err, 'Metro did not answer.'), progress.done)); })
      .then(() => reload(client))
      .catch(logError('mail-move'))
      .finally(() => {
        busy.current = false;
        setRunning(null);
      });
  };
  return { running, error, applied, run };
}

export interface Toggle {
  busy: boolean;
  error: string | null;
  run: () => void;
}

export function useToggle(job: () => Promise<unknown>, failure: string): Toggle {
  const client = useQueryClient();
  const going = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    setError(null);
    job()
      .catch((err: unknown) => { setError(queryError(err, failure)); })
      .then(() => reload(client))
      .catch(logError('mail-move'))
      .finally(() => {
        going.current = false;
        setBusy(false);
      });
  };
  return { busy, error, run };
}

export const channelSwitch = (ids: MoveIds, on: boolean): (() => Promise<unknown>) => () => setAccountEnabled(ids.boxAgentId, ids.station, ids.accountId, on);

export const eventOff = (move: MailMove, ids: MoveIds): (() => Promise<unknown>) => () => {
  const connector = move.target?.connector;
  if (connector === undefined) return Promise.resolve();
  return setConnectorAgentEvents(connector.id, ids.serverId, { events: withEvent(move.held?.events ?? [], MAIL_EVENT, false) });
};
