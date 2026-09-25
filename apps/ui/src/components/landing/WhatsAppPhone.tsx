import { type ReactNode, useState } from 'react';
import './whatsapp.css';

export interface WaMessage {
  id: string;
  from: 'me' | 'them';
  time: string;
  text?: string;
  doc?: { name: string; meta: string };
}

interface WhatsAppPhoneProps {
  name: string;
  avatar?: string;
  messages: WaMessage[];
  typing: boolean;
}

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function Glyph({ children, size = 22 }: { children: ReactNode; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
      {children}
    </svg>
  );
}

function Header({ name, avatar, typing }: { name: string; avatar?: string; typing: boolean }): ReactNode {
  const [broken, setBroken] = useState(false);
  return (
    <div className="wa-header">
      <Glyph size={24}>
        <path d="M15 5l-7 7 7 7" />
      </Glyph>
      <span className="wa-avatar" aria-hidden="true">
        {avatar === undefined || broken ? (
          <svg width="34" height="34" viewBox="0 0 34 34">
            <circle cx="17" cy="17" r="17" className="wa-avatar-bg" />
            <circle cx="17" cy="13.5" r="5.5" className="wa-avatar-fg" />
            <path d="M7.5 28.5a10 10 0 0119 0A16.9 16.9 0 0117 34a16.9 16.9 0 01-9.5-5.5z" className="wa-avatar-fg" />
          </svg>
        ) : (
          <img
            className="wa-avatar-img"
            src={avatar}
            alt=""
            width={34}
            height={34}
            onError={() => {
              setBroken(true);
            }}
          />
        )}
      </span>
      <span className="wa-who">
        <span className="wa-name">{name}</span>
        <span className="wa-presence">{typing ? 'typing…' : 'online'}</span>
      </span>
      <span className="wa-actions">
        <Glyph>
          <rect x="2.5" y="6.5" width="13" height="11" rx="2.5" />
          <path d="M15.5 10.5l6-3.5v10l-6-3.5z" />
        </Glyph>
        <Glyph>
          <path d="M5 4h3.5l1.5 4.5-2.2 1.4a11 11 0 005.3 5.3l1.4-2.2L19 14.5V18a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z" />
        </Glyph>
      </span>
    </div>
  );
}

function Ticks(): ReactNode {
  return (
    <svg className="wa-ticks" width="17" height="11" viewBox="0 0 17 11" aria-label="Read">
      <path d="M1 5.8l2.9 2.9L10.4 1.6M6.2 8.3l.4.4L13.1 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DocCard({ doc }: { doc: { name: string; meta: string } }): ReactNode {
  return (
    <span className="wa-doc">
      <svg width="26" height="32" viewBox="0 0 26 32" aria-hidden="true">
        <path d="M3 1h14l8 8v20a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2z" className="wa-doc-page" />
        <path d="M17 1v6a2 2 0 002 2h6" className="wa-doc-fold" />
        <text x="13" y="24" textAnchor="middle" className="wa-doc-label">
          PDF
        </text>
      </svg>
      <span className="wa-doc-text">
        <span className="wa-doc-name">{doc.name}</span>
        <span className="wa-doc-meta">{doc.meta}</span>
      </span>
    </span>
  );
}

function Bubble({ message, tail }: { message: WaMessage; tail: boolean }): ReactNode {
  return (
    <div className={`wa-row wa-row-${message.from}${tail ? ' wa-tail' : ''}`}>
      <div className={`wa-bubble wa-${message.from}`}>
        {message.doc === undefined ? null : <DocCard doc={message.doc} />}
        {message.text === undefined ? null : <span className="wa-text">{message.text}</span>}
        <span className="wa-meta">
          {message.time}
          {message.from === 'me' ? <Ticks /> : null}
        </span>
      </div>
    </div>
  );
}

function InputBar(): ReactNode {
  return (
    <div className="wa-input">
      <Glyph size={24}>
        <path d="M12 5v14M5 12h14" />
      </Glyph>
      <span className="wa-field">
        <Glyph size={20}>
          <path d="M14 20H7a3 3 0 01-3-3V7a3 3 0 013-3h10a3 3 0 013 3v7z" />
          <path d="M14 20v-3a3 3 0 013-3h3" />
        </Glyph>
      </span>
      <Glyph size={24}>
        <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
        <circle cx="12" cy="13" r="3.5" />
      </Glyph>
      <Glyph size={24}>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />
      </Glyph>
    </div>
  );
}

export function WhatsAppPhone({ name, avatar, messages, typing }: WhatsAppPhoneProps): ReactNode {
  return (
    <div className="wa-phone" aria-label={`WhatsApp chat with ${name}`}>
      <Header name={name} avatar={avatar} typing={typing} />
      <div className="wa-chat">
        <div className="wa-day">Today</div>
        <div className="wa-secure">
          <Glyph size={11}>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 018 0v3" />
          </Glyph>{' '}
          Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.
        </div>
        {messages.map((message, i) => (
          <Bubble key={message.id} message={message} tail={messages[i + 1]?.from !== message.from} />
        ))}
        {typing ? (
          <div className="wa-row wa-row-them wa-tail">
            <div className="wa-bubble wa-them wa-typing" aria-label={`${name} is typing`}>
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>
      <InputBar />
    </div>
  );
}
