import { describe, expect, test } from 'bun:test';
import { parseChannelMessage } from '../src/components/channel-message.ts';

const WRAPPED =
  '<channel source="metro" line="metro://telegram/RkonzsoqR0e/-4619935123" from="metro://telegram/RkonzsoqR0e/user/3072264" station="telegram" ts="2025-08-13T11:35:16.000Z" message_id="2257" line_name="Snapshot &lt;&gt; dRPC" from_name="@Sekhmet" from_display_name="[object Object]">\nhey, thanks\ndo you monitor timeouts? </channel>';

describe('a relayed chat message inside a transcript', () => {
  test('the wrapper is read off: text, sender, room and station, with entities decoded and the broken display name skipped', () => {
    expect(parseChannelMessage(WRAPPED)).toEqual({ text: 'hey, thanks\ndo you monitor timeouts?', from: '@Sekhmet', line: 'Snapshot <> dRPC', station: 'telegram' });
  });

  test('a display name wins over the handle, and a missing room is null', () => {
    const dm = '<channel source="metro" line="metro://telegram/x/25220238" station="telegram" from_name="@kozak" from_display_name="Vladimir">Sure</channel>';
    expect(parseChannelMessage(dm)).toEqual({ text: 'Sure', from: 'Vladimir', line: null, station: 'telegram' });
  });

  test('a prompt typed in the terminal is not a channel message', () => {
    expect(parseChannelMessage('fix the build')).toBeNull();
    expect(parseChannelMessage('<channel>')).toBeNull();
  });
});
