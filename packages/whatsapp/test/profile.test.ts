import { describe, expect, test } from 'bun:test';
import { makeNameBook } from '../src/names.ts';
import { limiter, NO_PICTURE_MS, PictureMemory, pictureOf, PROFILE_READS, RATE_LIMITED_MS, readPeer, withName } from '../src/profile.ts';

type Socket = Parameters<typeof readPeer>[0];
type PictureType = 'image' | 'preview';

const LID = '183103582650419@lid';
const PN = '41791234567@s.whatsapp.net';

const refused = (statusCode: number): Error => Object.assign(new Error('not-authorized'), { output: { statusCode } });

interface Fake {
  sock: Socket;
  asked: string[];
}

function fakeSocket(pictures: Record<string, Partial<Record<PictureType, string | Error>>>, mapping: Record<string, string> = {}): Fake {
  const asked: string[] = [];
  const sock = {
    fetchStatus: () => Promise.resolve([{ id: LID, status: { status: 'At work' } }]),
    profilePictureUrl: (jid: string, type: PictureType) => {
      asked.push(`${jid} ${type}`);
      const answer = pictures[jid]?.[type];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    signalRepository: {
      lidMapping: {
        getPNForLID: (lid: string) => Promise.resolve(mapping[lid] ?? null),
        getLIDForPN: (pn: string) => Promise.resolve(Object.entries(mapping).find(([, p]) => p === pn)?.[0] ?? null),
      },
    },
  } as unknown as Socket;
  return { sock, asked };
}

describe('the picture of a person in the People list', () => {
  test('the full picture first, then the preview', async () => {
    const { sock, asked } = fakeSocket({ [LID]: { preview: 'https://pps.whatsapp.net/preview.jpg' } });
    expect(await pictureOf(sock, [LID], new PictureMemory())).toBe('https://pps.whatsapp.net/preview.jpg');
    expect(asked).toEqual([`${LID} image`, `${LID} preview`]);
  });

  test('a lid that is refused falls back to the phone number, and the refusal is remembered', async () => {
    const { sock, asked } = fakeSocket({ [LID]: { image: refused(401), preview: refused(401) }, [PN]: { image: 'https://pps.whatsapp.net/full.jpg' } });
    const none = new PictureMemory();
    expect(await pictureOf(sock, [LID, PN], none)).toBe('https://pps.whatsapp.net/full.jpg');
    asked.length = 0;
    expect(await pictureOf(sock, [LID, PN], none)).toBe('https://pps.whatsapp.net/full.jpg');
    expect(asked).toEqual([`${PN} image`]);
  });

  test('a privacy refusal is asked again only after a while, a timeout at the next lookup', async () => {
    let now = 1_800_000_000_000;
    const none = new PictureMemory(() => now);
    const { sock, asked } = fakeSocket({ [LID]: { image: refused(401), preview: refused(404) }, [PN]: { image: refused(408), preview: refused(408) } });
    await pictureOf(sock, [LID, PN], none);
    expect(asked).toEqual([`${LID} image`, `${LID} preview`, `${PN} image`]);
    asked.length = 0;
    await pictureOf(sock, [LID, PN], none);
    expect(asked).toEqual([`${PN} image`]);
    now += NO_PICTURE_MS;
    asked.length = 0;
    await pictureOf(sock, [LID], none);
    expect(asked).toEqual([`${LID} image`, `${LID} preview`]);
  });

  test('any error that is not a refusal stops the lookup, without trying the preview or the other id', async () => {
    const { sock, asked } = fakeSocket({ [LID]: { image: new Error('socket closed') }, [PN]: { image: 'https://pps.whatsapp.net/full.jpg' } });
    expect(await pictureOf(sock, [LID, PN], new PictureMemory())).toBeUndefined();
    expect(asked).toEqual([`${LID} image`]);
  });

  test('a rate limit stops every picture lookup of the account for 30 minutes', async () => {
    let now = 1_800_000_000_000;
    const memory = new PictureMemory(() => now);
    const { sock, asked } = fakeSocket({ [LID]: { image: refused(429) }, [PN]: { image: new Error('rate-overlimit') } });
    expect(await pictureOf(sock, [LID, PN], memory)).toBeUndefined();
    expect(asked).toEqual([`${LID} image`]);
    now += RATE_LIMITED_MS - 1;
    expect(await pictureOf(sock, [PN], memory)).toBeUndefined();
    expect(asked).toEqual([`${LID} image`]);
    now += 1;
    expect(await pictureOf(sock, [PN], memory)).toBeUndefined();
    expect(asked).toEqual([`${LID} image`, `${PN} image`]);
    expect(memory.limited()).toBe(true);
  });

  test('no picture is asked once the lookup has spent its budget', async () => {
    const { sock, asked } = fakeSocket({ [LID]: { image: 'https://pps.whatsapp.net/full.jpg' } });
    expect(await pictureOf(sock, [LID], new PictureMemory(), Date.now() - 1)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test('profile reads go to WhatsApp a few at a time', async () => {
    const reads = limiter(PROFILE_READS);
    let active = 0;
    let most = 0;
    const one = async (): Promise<number> => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return most;
    };
    await Promise.all(Array.from({ length: 50 }, () => reads(one)));
    expect(most).toBe(PROFILE_READS);
    expect(active).toBe(0);
    await expect(reads(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await reads(() => Promise.resolve('next'))).toBe('next');
  });
});

describe('the name and number of a person in the People list', () => {
  test('a lid gets its number, its about text and a name saved under the number', async () => {
    const { sock } = fakeSocket({}, { [LID]: PN });
    const names = makeNameBook();
    names.note(PN, 'Jan');
    const peer = await readPeer(sock, LID, new PictureMemory());
    expect(peer.other).toBe(PN);
    expect(withName(peer, names)).toEqual({ id: LID, display_name: 'Jan', name: '+41791234567', address: '+41791234567', about: 'At work' });
    expect(names.get(LID)).toBe('Jan');
  });

  test('a name learned after the lookup shows without waiting for the profile to be read again', async () => {
    const { sock } = fakeSocket({});
    const names = makeNameBook();
    const peer = await readPeer(sock, LID, new PictureMemory());
    expect(withName(peer, names).display_name).toBeUndefined();
    names.note(LID, 'Eve');
    expect(withName(peer, names).display_name).toBe('Eve');
  });

  test('a phone number id looks up its lid and finds the name there', async () => {
    const { sock } = fakeSocket({}, { [LID]: PN });
    const names = makeNameBook();
    names.note(LID, 'Jan');
    expect(withName(await readPeer(sock, PN, new PictureMemory()), names)).toMatchObject({ id: PN, display_name: 'Jan', name: '+41791234567' });
  });
});
