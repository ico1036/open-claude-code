/**
 * Markdown → Telegram HTML converter.
 *
 * Converts common Markdown formatting to Telegram Bot API HTML entities.
 * Uses a line-by-line parser to safely handle code blocks without regex disasters.
 *
 * Supported: code blocks, inline code, bold, italic, strikethrough,
 *            spoiler, links, blockquotes, headers.
 *
 * @see https://core.telegram.org/bots/api#html-style
 */

// ─── HTML Escaping ───────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

// ─── Inline Formatting ──────────────────────────────────────────────────────

/** Placeholder prefix for inline code during formatting (NUL-byte fenced) */
const IC_OPEN = "\x00IC";
const IC_CLOSE = "\x00";

/**
 * Apply inline Markdown formatting to a single line of text.
 * Code blocks must already be extracted before calling this.
 */
function formatInline(line: string): string {
  // 1. Extract inline code to protect from further formatting
  const codes: string[] = [];
  let text = line.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codes.length;
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${IC_OPEN}${idx}${IC_CLOSE}`;
  });

  // 2. Escape HTML in remaining text
  text = escapeHtml(text);

  // 3. Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 4. Italic: *text* (single asterisks left after bold consumed)
  text = text.replace(/\*(.+?)\*/g, "<i>$1</i>");
  // _text_ only when not surrounded by alphanumeric (avoid file_name_here)
  text = text.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 5. Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 6. Spoiler: ||text||
  text = text.replace(/\|\|(.+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");

  // 7. Links: [text](url)
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, linkText: string, url: string) => `<a href="${url}">${linkText}</a>`,
  );

  // 8. Restore inline code
  text = text.replace(
    new RegExp(`${IC_OPEN.replace(/\x00/g, "\\x00")}(\\d+)${IC_CLOSE.replace(/\x00/g, "\\x00")}`, "g"),
    (_m, idx: string) => codes[parseInt(idx)],
  );

  return text;
}

// ─── Main Converter ─────────────────────────────────────────────────────────

/**
 * Convert Markdown text to Telegram HTML.
 *
 * Uses a line-by-line state machine to safely handle fenced code blocks,
 * then applies inline formatting to non-code lines.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];

  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];

  // Blockquote accumulator
  let blockquoteLines: string[] = [];

  const flushBlockquote = () => {
    if (blockquoteLines.length > 0) {
      result.push(`<blockquote>${blockquoteLines.join("\n")}</blockquote>`);
      blockquoteLines = [];
    }
  };

  for (const line of lines) {
    // ── Code fence detection ──
    const fenceMatch = line.match(/^```(\w*)\s*$/);

    if (fenceMatch && !inCodeBlock) {
      flushBlockquote();
      inCodeBlock = true;
      codeBlockLang = fenceMatch[1];
      codeBlockLines = [];
      continue;
    }

    if (inCodeBlock && /^```\s*$/.test(line)) {
      inCodeBlock = false;
      const langAttr = codeBlockLang
        ? ` class="language-${escapeHtmlAttr(codeBlockLang)}"`
        : "";
      const code = escapeHtml(codeBlockLines.join("\n"));
      result.push(`<pre><code${langAttr}>${code}</code></pre>`);
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // ── Blockquote: > text ──
    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      blockquoteLines.push(formatInline(bqMatch[1]));
      continue;
    }
    flushBlockquote();

    // ── Header: # text → bold ──
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      result.push(`<b>${formatInline(headerMatch[2])}</b>`);
      continue;
    }

    // ── Regular line ──
    result.push(formatInline(line));
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    const langAttr = codeBlockLang
      ? ` class="language-${escapeHtmlAttr(codeBlockLang)}"`
      : "";
    const code = escapeHtml(codeBlockLines.join("\n"));
    result.push(`<pre><code${langAttr}>${code}</code></pre>`);
  }

  flushBlockquote();

  return result.join("\n");
}
