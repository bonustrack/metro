import { describe, expect, test } from 'bun:test';
import { makeNameBook } from '../src/names.ts';
import { NO_PICTURE_MS, NoPictures, pictureOf, readPeer, withName } from '../src/profile.ts';

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
    expect(await pictureOf(sock, [LID], new NoPictures())).toBe('https://pps.whatsapp.net/preview.jpg');
    expect(asked).toEqual([`${LID} image`, `${LID} preview`]);
  });

  test('a lid that is refused falls back to the phone number, and the refusal is remembered', async () => {
    const { sock, asked } = fakeSocket({ [LID]: { image: refused(401), preview: refused(401) }, [PN]: { image: 'https://pps.whatsapp.net/full.jpg' } });
    const none = new NoPictures();
    expect(await pictureOf(sock, [LID, PN], none)).toBe('https://pps.whatsapp.net/full.jpg');
    asked.length = 0;
    expect(await pictureOf(sock, [LID, PN], none)).toBe('https://pps.whatsapp.net/full.jpg');
    expect(asked).toEqual([`${PN} image`]);
  });

  test('a privacy refusal is asked again only after a while, a timeout at once', async () => {
    let now = 1_800_000_000_000;
    const none = new NoPictures(() => now);
    const { sock, asked } = fakeSocket({ [LID]: { image: refused(401), preview: refused(404) }, [PN]: { image: refused(408), preview: refused(408) } });
    await pictureOf(sock, [LID, PN], none);
    asked.length = 0;
    await pictureOf(sock, [LID, PN], none);
    expect(asked).toEqual([`${PN} image`, `${PN} preview`]);
    now += NO_PICTURE_MS;
    asked.length = 0;
    await pictureOf(sock, [LID], none);
    expect(asked).toEqual([`${LID} image`, `${LID} preview`]);
  });
});

describe('the name and number of a person in the People list', () => {
  test('a lid gets its number, its about text and a name saved under the number', async () => {
    const { sock } = fakeSocket({}, { [LID]: PN });
    const names = makeNameBook();
    names.note(PN, 'Jan');
    const peer = await readPeer(sock, LID, new NoPictures());
    expect(peer.other).toBe(PN);
    expect(withName(peer, names)).toEqual({ id: LID, display_name: 'Jan', name: '+41791234567', address: '+41791234567', about: 'At work' });
    expect(names.get(LID)).toBe('Jan');
  });

  test('a name learned after the lookup shows without waiting for the profile to be read again', async () => {
    const { sock } = fakeSocket({});
    const names = makeNameBook();
    const peer = await readPeer(sock, LID, new NoPictures());
    expect(withName(peer, names).display_name).toBeUndefined();
    names.note(LID, 'Eve');
    expect(withName(peer, names).display_name).toBe('Eve');
  });

  test('a phone number id looks up its lid and finds the name there', async () => {
    const { sock } = fakeSocket({}, { [LID]: PN });
    const names = makeNameBook();
    names.note(LID, 'Jan');
    expect(withName(await readPeer(sock, PN, new NoPictures()), names)).toMatchObject({ id: PN, display_name: 'Jan', name: '+41791234567' });
  });
});
