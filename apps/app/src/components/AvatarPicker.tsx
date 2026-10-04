import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setServerAvatar, type Server } from '@metro-labs/client/api/servers';
import { queryError, refreshServers } from '../lib/queries.js';
import { pickAvatar } from '../lib/pick-avatar.js';

export interface AvatarPicker {
  pick: () => void;
  remove: () => void;
  busy: boolean;
  error: string | null;
}

export function useImagePicker(store: (avatar: string | null) => Promise<unknown>): AvatarPicker {
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
  return {
    pick: () => {
      setError(null);
      pickAvatar()
        .then((url) => {
          if (url !== null) save(Promise.resolve(url));
        })
        .catch((err: unknown) => {
          setError(queryError(err, 'Could not read that image.'));
        });
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
