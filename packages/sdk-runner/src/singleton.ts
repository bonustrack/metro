import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

export async function claimRunner(home: string): Promise<() => Promise<void>> {
  const hash = createHash('sha256').update(home).digest('hex');
  const server = createServer((socket) => { socket.destroy(); });
  const address = process.platform === 'linux' ? { path: `\0metro-sdk-${hash}` } : { host: '127.0.0.1', port: 30_000 + parseInt(hash.slice(0, 4), 16) % 30_000 };
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => { reject(new Error('The Agent SDK runner is already running, or its local process lock is unavailable.')); });
    server.listen(address, resolve);
  });
  return () => new Promise<void>((resolve, reject) => {
    server.close((err) => { if (err === undefined) resolve(); else reject(err); });
  });
}
