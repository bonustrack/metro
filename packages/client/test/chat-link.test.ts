import { describe, expect, test } from 'bun:test';
import { chatLink } from '../src/api/senders.ts';

describe('the chat link next to a listed sender', () => {
  test('opens the right app for each channel, and nothing when the id cannot be reached', () => {
    expect(chatLink('telegram-bot', '4242', '@ada')).toBe('https://t.me/ada');
    expect(chatLink('telegram', '4242')).toBe('tg://user?id=4242');
    expect(chatLink('discord-bot', '81234567890')).toBe('https://discord.com/users/81234567890');
    expect(chatLink('whatsapp', '41791234567@s.whatsapp.net')).toBe('https://wa.me/41791234567');
    expect(chatLink('whatsapp', '1234@lid')).toBeNull();
    expect(chatLink('threema', 'echoecho')).toBe('https://threema.id/ECHOECHO');
    expect(chatLink('outlook', 'andy@anderra.ch')).toBe('mailto:andy@anderra.ch');
    expect(chatLink('outlook', '@anderra.ch')).toBeNull();
    expect(chatLink('xmtp', 'abc')).toBeNull();
  });
});
