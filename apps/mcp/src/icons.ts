import { brandIcons, type ConnectorIcon } from '@metro-labs/core/brands';
import { errMsg, log } from '@metro-labs/core/log';
import { checkedFaviconUrl } from '@metro-labs/core/favicon';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { Flights } from './flights.js';

const ICON_SIZE = 64;
const CHECK_MS = 3_000;
const KNOWN_MS = 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const KNOWN_MAX = 1000;

interface Checked {
  found: boolean;
  until: number;
}

export class Favicons {
  private readonly known = new Map<string, Checked>();
  private readonly flights = new Flights<boolean>();

  constructor(
    private readonly fetch: FetchLike,
    private readonly now: () => number,
  ) {}

  async iconsOf(url: string): Promise<ConnectorIcon[]> {
    const brand = brandIcons(url);
    if (brand.length > 0) return brand;
    const src = checkedFaviconUrl(url, ICON_SIZE);
    if (src === '' || !(await this.found(src))) return [];
    return [{ src, mimeType: 'image/png', sizes: [`${String(ICON_SIZE)}x${String(ICON_SIZE)}`] }];
  }

  private async found(src: string): Promise<boolean> {
    const held = this.known.get(src);
    if (held !== undefined && held.until > this.now()) return held.found;
    return this.flights.run(src, async () => {
      let checked: Checked;
      try {
        const res = await this.fetch(src, { redirect: 'manual', signal: AbortSignal.timeout(CHECK_MS) });
        await res.body?.cancel();
        checked = { found: res.status === 200, until: this.now() + KNOWN_MS };
      } catch (err) {
        log.debug({ err: errMsg(err) }, 'mcp: a favicon could not be checked');
        checked = { found: false, until: this.now() + RETRY_MS };
      }
      this.known.delete(src);
      this.known.set(src, checked);
      for (const oldest of this.known.keys()) {
        if (this.known.size <= KNOWN_MAX) break;
        this.known.delete(oldest);
      }
      return checked.found;
    });
  }
}
