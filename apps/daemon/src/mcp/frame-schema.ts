export const frameSchema = {
  type: 'object',
  description:
    'Stage (XMTP) only: a frame, a small interactive view. Stage shows it in the chat at image size ' +
    '(400 x 400 at most, its start screen, clipped with a fade) and opens it full screen on a tap; its ' +
    'buttons work only there. `widget` is OpenAI ChatKit widget JSON (a Card, ListView ' +
    'or Basic root, 64K characters at most); a missing `title` or `description` is taken from the ' +
    'widget. Or give `screens` instead of `widget` for several screens in one frame. A tap there comes back ' +
    'to you as a reply to the frame: "Frame action: <type> <payload ' +
    "JSON>\". It is sent after the text, and the message_id returned is the frame's. The stage " +
    'skill lists the widget nodes, with an example.',
  properties: {
    widget: {
      type: 'object',
      description:
        'ChatKit widget JSON, e.g. {"type":"Card","children":[{"type":"Title","value":"Deploy?"},' +
        '{"type":"Button","label":"Ship it","onClickAction":{"type":"deploy","payload":{"env":"prod"}}}]}.',
      additionalProperties: true,
    },
    screens: {
      type: 'object',
      description:
        'Instead of `widget`: up to 50 screens by id, each a widget or {"title", "widget"}, 64K ' +
        'characters in all. An action {"type":"frame.open","payload":{"screen":"<id>"}} opens a ' +
        'screen and {"type":"frame.back"} goes back, in Stage, with no message to you.',
      additionalProperties: true,
    },
    start: { type: 'string', description: 'Required with `screens`: the id of the first screen.' },
    title: { type: 'string', description: 'Card title in the chat (200 characters at most).' },
    description: { type: 'string', description: 'Card description in the chat (1000 characters at most).' },
    source: {
      type: 'object',
      description:
        'Optional: {"url": "https://…"}, a node URL that serves this widget live (2048 characters at most). ' +
        "Stage then sends the frame's actions to that node, not to you, and the node's reply replaces the " +
        'frame on that device, with no message to you. Only an action with "handler": "client" (e.g. ' +
        '{"type": "ask", "handler": "client"}) still comes back to you as a Frame action; without a source, ' +
        "every action does. Refresh is in the frame's three-dot menu, so a node needs no Refresh button. " +
        'Add to dashboard on the frame then adds a live widget loaded from that URL instead of a copy.',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
} as const;
