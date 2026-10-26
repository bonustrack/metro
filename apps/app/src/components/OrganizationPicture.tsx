import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { setOrganizationAvatar } from '@metro-labs/client/api/organization';
import { useImagePicker } from './AvatarPicker.js';
import { useConfirm } from './DeleteMenu.js';
import { AskDialog } from './settings/AskDialog.js';
import { Item } from './ui/Item.js';
import { OrgMark } from './ui/OrgMark.js';
import { AVATAR_SIZE } from './ui/sizes.js';
import { refreshOrganizations } from '../lib/queries.js';

const REMOVE_LINES = ['The organization shows the first letter of its name again.'];

function subtitleOf(avatar: string | null, error: string | null): string {
  if (error !== null) return error;
  return avatar === null ? 'The first letter of the name for now' : 'Shown next to the name';
}

function PictureButtons({ shown, busy, onPick, onRemove }: { shown: boolean; busy: boolean; onPick: () => void; onRemove: () => void }): ReactNode {
  return (
    <Row gap={8} align="center">
      {shown ? <Button size="sm" color="secondary" label="Remove" disabled={busy} onPress={onRemove} /> : null}
      <Button size="sm" color="secondary" label={busy ? 'Saving…' : shown ? 'Change' : 'Add'} loading={busy} disabled={busy} onPress={onPick} />
    </Row>
  );
}

export function OrganizationPicture({ name, avatar, admin }: { name: string; avatar: string | null; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const picker = useImagePicker(async (next) => {
    await setOrganizationAvatar(next);
    await refreshOrganizations(client);
  });
  const removing = useConfirm(async () => {
    await setOrganizationAvatar(null);
    await refreshOrganizations(client);
  }, 'Could not remove the picture.');
  return (
    <>
      <Item
        title="Picture"
        subtitle={subtitleOf(avatar, picker.error)}
        subtitleTone={picker.error === null ? 'secondary' : 'danger'}
        leading={<OrgMark name={name} src={avatar} size={AVATAR_SIZE.list} />}
        trailing={admin ? <PictureButtons shown={avatar !== null} busy={picker.busy || removing.busy} onPick={picker.pick} onRemove={removing.show} /> : undefined}
        chevron={false}
      />
      <AskDialog open={removing.open} title="Remove the picture?" lines={REMOVE_LINES} action="Remove" busy={removing.busy} error={removing.error} onClose={removing.close} onConfirm={removing.confirm} />
    </>
  );
}
