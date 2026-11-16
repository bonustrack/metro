import { type ReactNode, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { createLoginLink, removeLoginLink, type LoginLink, type NewLoginLink, type UserRow } from '@metro-labs/client/api/admin';
import { CopyBlock } from '../CopyBlock.js';
import { Modal, ModalText } from '../Modal.js';
import { AskDialog } from '../settings/AskDialog.js';
import { Actions } from '../ui/Actions.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ADMIN_USERS_KEY } from '../../lib/admin-queries.js';
import { userName } from '../../lib/admin-people.js';
import { agoWords } from '../../lib/admin-table.js';
import { queryError } from '../../lib/queries.js';

type Asking = 'replace' | 'remove' | null;

interface LinkActions {
  asking: Asking;
  made: NewLoginLink | null;
  busy: boolean;
  error: string | null;
  ask: (next: Asking) => void;
  make: () => void;
  remove: () => void;
  hide: () => void;
}

type LinkState = 'none' | 'waiting' | 'used' | 'expired';

const since = (at: number, now: number): string => agoWords(at, now).toLowerCase();
const DAY_MS = 24 * 60 * 60_000;

function stateOf(link: LoginLink | null, now: number): LinkState {
  if (link === null) return 'none';
  if (link.usedAt !== null) return 'used';
  return link.expiresAt !== null && link.expiresAt <= now ? 'expired' : 'waiting';
}

const TITLES: Record<LinkState, string> = { none: 'No login link', waiting: 'A login link waits to be used', used: 'The login link was used', expired: 'The login link expired' };

function daysLeft(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return '';
  const days = Math.max(1, Math.ceil((expiresAt - now) / DAY_MS));
  return ` · works for ${String(days)} more ${days === 1 ? 'day' : 'days'}`;
}

function linkLine(user: UserRow, state: LinkState, now: number): string {
  const link = user.loginLink;
  if (link === null || state === 'none') return `With a login link, ${userName(user)} signs in once without Google or Microsoft.`;
  if (state === 'used' && link.usedAt !== null) return `Used ${since(link.usedAt, now)}. Removing it signs out the session it opened.`;
  if (state === 'expired') return `Made ${since(link.createdAt, now)}, never used.`;
  return `Made ${since(link.createdAt, now)}${daysLeft(link.expiresAt, now)}`;
}

function useLinkActions(user: UserRow): LinkActions {
  const client = useQueryClient();
  const [asking, setAsking] = useState<Asking>(null);
  const [made, setMade] = useState<NewLoginLink | null>(null);
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
  const create = useMutation({ mutationFn: () => createLoginLink(user.id), onSuccess: (link) => { setAsking(null); setMade(link); }, onSettled: refresh });
  const drop = useMutation({ mutationFn: () => removeLoginLink(user.id), onSuccess: () => { setAsking(null); }, onSettled: refresh });
  const busy = create.isPending || drop.isPending;
  const failed = create.error ?? drop.error;
  return {
    asking,
    made,
    busy,
    error: failed === null ? null : queryError(failed, 'Could not change the login link.'),
    ask: (next) => {
      create.reset();
      drop.reset();
      setAsking(next);
    },
    make: () => { if (!busy) create.mutate(); },
    remove: () => { if (!busy) drop.mutate(); },
    hide: () => { setMade(null); },
  };
}

function ShownLink({ made, name, onClose }: { made: NewLoginLink | null; name: string; onClose: () => void }): ReactNode {
  if (made === null) return null;
  return (
    <Modal title={`Login link for ${name}`} open onClose={onClose}>
      <Column gap={20}>
        <ModalText>{`Copy it now, Metro shows it only once. It works once, within 7 days, and whoever opens it first signs in as ${name}.`}</ModalText>
        <CopyBlock label="Login link" value={made.url} />
        <Actions main={{ label: 'Done', onPress: onClose }} />
      </Column>
    </Modal>
  );
}

export function LoginLinkGroup({ user, now }: { user: UserRow; now: number }): ReactNode {
  const name = userName(user);
  const actions = useLinkActions(user);
  const state = stateOf(user.loginLink, now);
  const waiting = state === 'waiting';
  const close = (): void => { actions.ask(null); };
  return (
    <>
      <Group label="Login link" error={actions.asking === null ? actions.error : null}>
        <Item title={TITLES[state]} subtitle={linkLine(user, state, now)} chevron={false} />
        <Item title={state === 'none' ? 'Make a login link' : 'Make a new login link'} subtitle={actions.busy && actions.asking === null ? 'Making the link…' : undefined} chevron={false}
          onPress={waiting ? () => { actions.ask('replace'); } : actions.make} />
        {state === 'none' ? null : <Item title="Remove the login link" danger chevron={false} onPress={() => { actions.ask('remove'); }} />}
      </Group>
      <AskDialog open={actions.asking === 'replace'} title={`Make a new login link for ${name}?`} lines={['The new link replaces the one still waiting, which stops working at once.']} action="Make a new link"
        busy={actions.busy} error={actions.error} onClose={close} onConfirm={actions.make} />
      <AskDialog open={actions.asking === 'remove'} title={`Remove the login link of ${name}?`} lines={[`${name} can no longer sign in with it, and a session it opened is signed out. You can make a new one later.`]} action="Remove"
        busy={actions.busy} error={actions.error} onClose={close} onConfirm={actions.remove} />
      <ShownLink made={actions.made} name={name} onClose={actions.hide} />
    </>
  );
}
