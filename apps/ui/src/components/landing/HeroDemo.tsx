import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { Text } from '../ui.js';
import { WhatsAppPhone, type WaMessage } from './WhatsAppPhone.js';
import { ConnectorFavicon } from '../ConnectorFavicon.js';

interface Beat {
  stop: number;
  wait: number;
  typing?: boolean;
  message?: WaMessage;
}

const BEATS: Beat[] = [
  { stop: 0, wait: 700, message: { id: 'ask', from: 'me', time: '09:12', text: 'Hi Alice, can you prepare the Q3 board summary from the Finance folder in SharePoint?' } },
  { stop: 1, wait: 1300, typing: true },
  { stop: 1, wait: 1500, message: { id: 'ack', from: 'them', time: '09:12', text: 'On it. I am reading the four Q3 files in SharePoint.' } },
  { stop: 1, wait: 1700, typing: true },
  { stop: 1, wait: 2200, message: { id: 'doc', from: 'them', time: '09:14', doc: { name: 'Q3 board summary.pdf', meta: '3 pages · PDF · 184 kB' }, text: 'Here it is. Revenue is up 12% on Q2 and costs are flat.' } },
  { stop: 2, wait: 1800, message: { id: 'send', from: 'me', time: '09:15', text: 'Perfect. Please email it to the board.' } },
  { stop: 2, wait: 1200, typing: true },
  { stop: 2, wait: 2600, message: { id: 'prompt', from: 'them', time: '09:15', text: 'Approval needed: send\nOutlook, to board@yourcompany.ch\nReply "yes kqmtz" or "no kqmtz"' } },
  { stop: 3, wait: 1600, message: { id: 'yes', from: 'me', time: '09:16', text: 'yes kqmtz' } },
  { stop: 3, wait: 1000, typing: true },
  { stop: 3, wait: 0, message: { id: 'done', from: 'them', time: '09:16', text: 'Sent to the board.' } },
];

interface Stop {
  title: string;
  body: string;
  marks: { name: string; url: string }[];
  note?: string;
}

const STOPS: Stop[] = [
  {
    title: 'You ask in WhatsApp',
    body: 'Your message stays end to end encrypted until it reaches your agent’s own server.',
    marks: [{ name: 'WhatsApp', url: 'https://whatsapp.com' }],
  },
  {
    title: 'Alice works on your server',
    body: 'It reads the Q3 files in SharePoint through a connector. The model behind it keeps nothing.',
    marks: [
      { name: 'SharePoint', url: 'https://sharepoint.com' },
      { name: 'Claude', url: 'https://claude.ai' },
    ],
  },
  {
    title: 'It asks before it acts',
    body: 'Sending email is set to Ask. Only the approvers you name can say yes, right in the chat.',
    marks: [],
    note: 'Approval needed',
  },
  {
    title: 'Done, and reported back',
    body: 'The email leaves from your own Outlook, and Alice confirms in the chat.',
    marks: [{ name: 'Outlook', url: 'https://outlook.com' }],
  },
];

const STOP_MS = STOPS.map((_, i) => BEATS.filter((beat) => beat.stop === i).reduce((sum, beat) => sum + beat.wait, 0));

function fillStyle(ms: number): CSSProperties {
  return { animationDuration: `${String(Math.max(ms, 600))}ms` };
}

const LAST = BEATS.length - 1;
const LOOP_REST_MS = 5000;

function firstBeatOf(stop: number): number {
  return Math.max(0, BEATS.findIndex((beat) => beat.stop === stop && beat.message !== undefined));
}

function usePlayer(): { at: number; jump: (to: number) => void } {
  const [at, setAt] = useState(-1);
  useEffect(() => {
    const wait = at < 0 ? 600 : at >= LAST ? LOOP_REST_MS : (BEATS[at]?.wait ?? 0);
    const timer = window.setTimeout(() => {
      setAt((current) => (current >= LAST ? -1 : current + 1));
    }, wait);
    return () => {
      window.clearTimeout(timer);
    };
  }, [at]);
  return { at, jump: setAt };
}

function Caption({ stop, onPick }: { stop: number; onPick: (stop: number) => void }): ReactNode {
  const shown = STOPS[Math.max(0, stop)] ?? STOPS[0];
  if (shown === undefined) return null;
  return (
    <div className="lp-demo-cap">
      <div className="lp-demo-segs" role="tablist" aria-label="Steps">
        {STOPS.map((item, i) => (
          <button
            key={item.title}
            type="button"
            role="tab"
            aria-selected={i === stop}
            aria-label={item.title}
            className={`lp-demo-seg${i < stop ? ' is-done' : ''}${i === stop ? ' is-now' : ''}`}
            onClick={() => {
              onPick(i);
            }}
          >
            <span key={`${String(i)}-${String(stop)}`} className="lp-demo-fill" style={i === stop ? fillStyle(STOP_MS[i] ?? 0) : undefined} />
          </button>
        ))}
      </div>
      <div className="lp-demo-step" key={Math.max(0, stop)} aria-live="polite">
        <span className="lp-demo-count">{`Step ${String(Math.max(0, stop) + 1)} of ${String(STOPS.length)}`}</span>
        <span className="lp-demo-title">{shown.title}</span>
        <span className="lp-demo-body">{shown.body}</span>
        <span className="lp-demo-marks">
          {shown.marks.map((mark) => (
            <span key={mark.name} className="lp-acc-mark">
              <ConnectorFavicon name={mark.name} url={mark.url} size={16} />
              <Text size="xs">{mark.name}</Text>
            </span>
          ))}
          {shown.note === undefined ? null : (
            <span className="lp-acc-mark">
              <Text size="xs">{shown.note}</Text>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function HeroDemo(): ReactNode {
  const { at, jump } = usePlayer();
  const current = BEATS[Math.max(0, at)];
  const stop = at < 0 ? 0 : (current?.stop ?? 0);
  const messages = BEATS.slice(0, at + 1).flatMap((beat) => (beat.message === undefined ? [] : [beat.message]));
  return (
    <div className="lp-hero-panel">
      <img className="lp-hero-photo" src="/landing/office.webp" alt="A smiling executive reading a message from his agent in an office lobby" />
      <div className="lp-demo-card">
        <Caption
          stop={stop}
          onPick={(picked) => {
            jump(firstBeatOf(picked));
          }}
        />
      </div>
      <div className="lp-demo-phone">
        <WhatsAppPhone name="Alice" avatar="/landing/alice.png" messages={messages} typing={current?.typing === true && at >= 0} />
      </div>
    </div>
  );
}
