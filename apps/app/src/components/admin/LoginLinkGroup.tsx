import { type ReactNode, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { createLoginLink, removeLoginLink, type NewLoginLink, type UserRow } from '@metro-labs/client/api/admin';
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

const since = (at: number, now: number): string => agoWords(at, now).toLowerCase();

function linkLine(user: UserRow, now: number): string {
  const link = user.loginLink;
  if (link === null) return `With a login link, ${userName(user)} signs in without Google or Microsoft.`;
  return `Made ${since(link.createdAt, now)} · ${link.lastUsedAt === null ? 'never used' : `last used ${since(link.lastUsedAt, now)}`}`;
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
        <ModalText>{`Copy it now, Metro shows it only once. It works until you remove it, and anyone who has it can sign in as ${name}.`}</ModalText>
        <CopyBlock label="Login link" value={made.url} />
        <Actions main={{ label: 'Done', onPress: onClose }} />
      </Column>
    </Modal>
  );
}

export function LoginLinkGroup({ user, now }: { user: UserRow; now: number }): ReactNode {
  const name = userName(user);
  const actions = useLinkActions(user);
  const live = user.loginLink !== null;
  const close = (): void => { actions.ask(null); };
  return (
    <>
      <Group label="Login link" error={actions.asking === null ? actions.error : null}>
        <Item title={live ? 'A login link works' : 'No login link'} subtitle={linkLine(user, now)} chevron={false} />
        <Item title={live ? 'Make a new login link' : 'Make a login link'} subtitle={actions.busy && actions.asking === null ? 'Making the link…' : undefined} chevron={false}
          onPress={live ? () => { actions.ask('replace'); } : actions.make} />
        {live ? <Item title="Remove the login link" danger chevron={false} onPress={() => { actions.ask('remove'); }} /> : null}
      </Group>
      <AskDialog open={actions.asking === 'replace'} title={`Make a new login link for ${name}?`} lines={['The new link replaces the current one, which stops working at once.']} action="Make a new link"
        busy={actions.busy} error={actions.error} onClose={close} onConfirm={actions.make} />
      <AskDialog open={actions.asking === 'remove'} title={`Remove the login link of ${name}?`} lines={[`${name} can no longer sign in with it. You can make a new one later.`]} action="Remove"
        busy={actions.busy} error={actions.error} onClose={close} onConfirm={actions.remove} />
      <ShownLink made={actions.made} name={name} onClose={actions.hide} />
    </>
  );
}
