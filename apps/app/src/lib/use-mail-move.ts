import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FlatAccount } from '@metro-labs/client/api/accounts';
import type { StationsView } from '@metro-labs/client/api/client';
import type { ConnectorListing } from '@metro-labs/client/api/connectors';
import { heldBy, mailConnectors, moveStep, pickTarget, signedInMailbox, type Candidate, type ListingState, type MailStation, type MoveStep, type Target } from '@metro-labs/client/api/mail-move';
import { movePlan, moveTools, settingsCarried, type MovePlan, type MoveTool } from '@metro-labs/client/api/mail-move-plan';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import type { ToolPolicy } from '@metro-labs/client/api/policy';
import { logError } from './log.js';
import { mailServerOf, moveActions, movePollMs, type MoveAction } from './mail-move.js';
import { refreshOrgConnectors, useConnectorListings, useOrgConnectorsPoll } from './org-connector-queries.js';

type Held = OrgConnector['agents'][number];

export interface MailMoveInput {
  station: MailStation;
  mailbox: string;
  found: FlatAccount;
  view: StationsView;
  connectors: readonly OrgConnector[];
  listedAt: number;
  serverId: string;
  agent: string;
}

export interface MailMove {
  server: string;
  target: Target | null;
  held: Held | undefined;
  tools: readonly MoveTool[];
  plan: MovePlan;
  step: MoveStep;
  actions: MoveAction[];
  signingIn: boolean;
  confirm: () => void;
  noteSignIn: () => void;
  recheck: () => Promise<unknown>;
}

interface Listings {
  candidates: Candidate[];
  listingOf: (connector: string) => ConnectorListing | undefined;
  recheck: () => Promise<unknown>;
}

function useListings(connectors: readonly OrgConnector[], server: string, listedAt: number): Listings {
  const client = useQueryClient();
  const found = mailConnectors(connectors, server);
  const read = found.filter((connector) => connector.signIn === 'connected');
  const results = useConnectorListings(read);
  const stamp = results.map((result) => String(result.dataUpdatedAt)).join(',');
  useEffect(() => {
    if (stamp.split(',').some((at) => Number(at) > 0)) refreshOrgConnectors(client).catch(logError('mail-move'));
  }, [client, stamp]);
  const resultOf = (connector: string): (typeof results)[number] | undefined => results[read.findIndex((one) => one.id === connector)];
  const stateOf = (connector: string): ListingState => {
    const result = resultOf(connector);
    if (result?.data === undefined) return result?.isError === true ? 'failed' : 'loading';
    return result.dataUpdatedAt > listedAt ? 'loading' : { mailbox: signedInMailbox(result.data) };
  };
  return {
    candidates: found.map((connector) => ({ connector, listing: stateOf(connector.id) })),
    listingOf: (connector) => resultOf(connector)?.data,
    recheck: () => Promise.all(results.map((result) => result.refetch())),
  };
}

interface Settled {
  target: Target | null;
  held: Held | undefined;
  tools: readonly MoveTool[];
  plan: MovePlan;
}

function planOf(input: MailMoveInput, tools: readonly MoveTool[], organization: ToolPolicy, assigned: ToolPolicy | null): MovePlan {
  const { row } = input.found;
  return movePlan({ allowlist: row.allowlist, policy: row.policy, receiving: row.enabled, channelTools: input.view.tools[input.station] ?? [], tools, organization, assigned });
}

function settle(input: MailMoveInput, picked: Target | 'checking' | null, listings: Listings): Settled {
  const target = picked === 'checking' ? null : picked;
  if (target === null) {
    const tools = moveTools(null);
    return { target, held: undefined, tools, plan: planOf(input, tools, {}, null) };
  }
  const { connector } = target;
  const held = heldBy(connector, input.serverId);
  const tools = moveTools(listings.listingOf(connector.id)?.tools ?? null);
  return { target, held, tools, plan: planOf(input, tools, connector.policy, held?.policy ?? null) };
}

const signInOf = (target: Target | null): string | null => (target === null ? null : `${target.connector.id}:${target.connector.verifiedAt ?? ''}`);

export function useMailMove(input: MailMoveInput): MailMove {
  const { mailbox, found, serverId, agent } = input;
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [signInFrom, setSignInFrom] = useState<string | null | undefined>(undefined);
  const server = mailServerOf(input.station);
  const listings = useListings(input.connectors, server, input.listedAt);
  const picked = pickTarget(mailbox, listings.candidates);
  const settled = settle(input, picked, listings);
  const { plan, held, tools } = settled;
  const receiving = found.row.enabled;
  const signedIn = signInOf(settled.target);
  const verifiedAt = settled.target?.connector.verifiedAt ?? null;
  const signingIn = signInFrom !== undefined && signInFrom === verifiedAt;
  const step = moveStep({ receiving, target: picked, agentId: serverId, confirmed: signedIn !== null && confirmedFor === signedIn, carried: settingsCarried(plan, held, tools) });
  useOrgConnectorsPoll(movePollMs(step, signingIn));
  return {
    ...settled,
    server,
    step,
    actions: moveActions({ plan, held, receiving, connector: settled.target?.connector.name ?? mailbox, agent, tools }),
    signingIn,
    confirm: () => { setConfirmedFor(signedIn); },
    noteSignIn: () => { setSignInFrom(verifiedAt); },
    recheck: listings.recheck,
  };
}
