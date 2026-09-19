import { type ReactNode, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setServerAvatar, type Server } from '../api/servers.js';
import { queryError, refreshServers } from '../api/queries.js';
import { AVATAR_ACCEPT, readAvatar } from './avatar-file.js';

export interface AvatarPicker {
  input: ReactNode;
  pick: () => void;
  remove: () => void;
  busy: boolean;
  error: string | null;
}

export function useImagePicker(store: (avatar: string | null) => Promise<unknown>): AvatarPicker {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (avatar: Promise<string | null>): void => {
    setBusy(true);
    setError(null);
    avatar
      .then((next) => store(next))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the avatar.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const input = (
    <input
      ref={ref}
      type="file"
      className="hidden-input"
      accept={AVATAR_ACCEPT}
      onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (file !== undefined) save(readAvatar(file));
      }}
    />
  );
  return {
    input,
    pick: () => {
      ref.current?.click();
    },
    remove: () => {
      save(Promise.resolve(null));
    },
    busy,
    error,
  };
}

export function useAvatarPicker(server: Server): AvatarPicker {
  const client = useQueryClient();
  return useImagePicker(async (next) => {
    await setServerAvatar(server.id, next);
    await refreshServers(client);
  });
}
