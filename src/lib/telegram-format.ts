// Convert agent-style markdown to Telegram's HTML parse mode.
//
// Telegram HTML accepts only a small tag set: <b>, <i>, <u>, <s>, <code>,
// <pre>, <a href>, <blockquote>, <tg-spoiler>. Outside tags, the only chars
// requiring escape are <, >, &.
//
// Designed to be safe on streaming partial input — unmatched markers
// (e.g. a half-typed `**bold` mid-flush) fall through as literal text
// rather than producing unbalanced tags, so every intermediate state is
// a valid HTML message Telegram will accept.

const ENTITY_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function esc(s: string): string {
  return s.replace(/[&<>]/g, c => ENTITY_MAP[c]);
}

// Sentinel for stashed HTML fragments. `\x01` (SOH) is a C0 control char
// that's both invalid in Telegram message text and never legitimately
// appears in agent output — so collisions are impossible in practice.
const SENT = '\x01';

/**
 * Render GitHub-flavored markdown (the kind agents emit) as Telegram HTML.
 */
export function mdToTelegramHtml(md: string): string {
  const slots: string[] = [];
  const stash = (html: string): string => {
    slots.push(html);
    return `${SENT}${slots.length - 1}${SENT}`;
  };

  // Fenced code blocks first — their contents must not be touched by any
  // other rule. Optional language hint becomes `language-*` on the inner
  // <code>, which Telegram passes through.
  let work = md.replace(/```([A-Za-z0-9_+\-.]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const inner = lang
      ? `<pre><code class="language-${esc(lang)}">${esc(code)}</code></pre>`
      : `<pre>${esc(code)}</pre>`;
    return stash(inner);
  });

  // Inline code. Multi-line spans are skipped — those are likely an
  // unclosed fence still mid-stream; collapsing them would mangle output.
  work = work.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code>${esc(code)}</code>`));

  // Outside the stashes is plain text — escape now so any literal angle
  // brackets in agent output can't be confused with HTML tags below.
  work = esc(work);

  // Links [text](url).
  work = work.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const safeUrl = url.replace(/"/g, '%22');
    return stash(`<a href="${safeUrl}">${text}</a>`);
  });

  // Bold runs before italic so the single-`*` rule doesn't eat the inner
  // half of a `**bold**` pair.
  work = work.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
  work = work.replace(/__([^_\n]+?)__/g, '<b>$1</b>');

  // Italic. The `\S` guards on both sides of the marker prevent matching
  // arithmetic like `2 * 3 * 4` or identifiers like `foo_bar`, which
  // agents emit often — standard markdown requires the markers to hug
  // non-whitespace content.
  work = work.replace(/(^|[^*\w])\*(\S[^*\n]*?\S|\S)\*(?!\w)/g, '$1<i>$2</i>');
  work = work.replace(/(^|[^_\w])_(\S[^_\n]*?\S|\S)_(?!\w)/g, '$1<i>$2</i>');

  // Strikethrough.
  work = work.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');

  // Headings → bold. Telegram has no heading element.
  work = work.replace(/^#{1,6}\s+(.+?)\s*$/gm, '<b>$1</b>');

  // Blockquotes — collapse consecutive `> ` lines into one <blockquote>.
  // `&gt;` because the escape pass already ran.
  work = work.replace(/(^|\n)((?:&gt;\s?[^\n]*\n?)+)/g, (_m, lead: string, block: string) => {
    const inner = block.replace(/^&gt;\s?/gm, '').replace(/\n+$/, '');
    const trailingNl = block.endsWith('\n') ? '\n' : '';
    return `${lead}<blockquote>${inner}</blockquote>${trailingNl}`;
  });

  // Restore stashed HTML fragments.
  work = work.replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (_m, idx: string) => slots[Number(idx)]);
  return work;
}
