export const LOCAL_NETWORK_PERMISSIONS = ['local-network', 'local-network-access'] as const;

export const LOCAL_NETWORK_BLOCKED =
  'This browser does not let metro.box reach devices on your local network, and a Tailscale address counts as one. In the site settings of metro.box, allow Local network access, then try again.';

interface PermissionSource<T> {
  query(descriptor: { name: string }): Promise<T>;
}

export async function firstPermission<T>(source: PermissionSource<T> | undefined, names: readonly string[] = LOCAL_NETWORK_PERMISSIONS): Promise<T | null> {
  if (source === undefined) return null;
  for (const name of names) {
    const status = await source.query({ name }).then(
      (found) => found,
      () => null,
    );
    if (status !== null) return status;
  }
  return null;
}
