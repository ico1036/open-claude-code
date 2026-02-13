/**
 * Markdown-aware text chunking for Telegram.
 *
 * Splits long Markdown text into chunks that respect Telegram's 4096-character
 * message limit. When a split occurs inside a fenced code block, the fence is
 * automatically closed in the current chunk and re-opened in the next.
 *
 * Split priority: paragraph boundary > line break > whitespace > hard cut.
 */

const DEFAULT_CHUNK_LIMIT = 4000; // Leave 96-char headroom for HTML tags

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Split Markdown text into chunks of at most `limit` characters.
 *
 * Preserves fenced code blocks across chunk boundaries by auto-closing
 * and re-opening fences when a split falls inside one.
 */
export function chunkMarkdown(
  text: string,
  limit: number = DEFAULT_CHUNK_LIMIT,
): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    const splitAt = findSplitPoint(remaining, limit);
    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Trim leading newlines from the next chunk
    remaining = remaining.replace(/^\n+/, "");

    // Check if we split inside an open code fence
    const openFence = findUnclosedFence(chunk);
    if (openFence) {
      // Close the fence in this chunk
      chunk += "\n```";
      // Re-open in the next chunk with the same language
      remaining = "```" + openFence.lang + "\n" + remaining;
    }

    const trimmed = chunk.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
  }

  return chunks;
}

// ─── Split Point Selection ──────────────────────────────────────────────────

function findSplitPoint(text: string, limit: number): number {
  // 1. Paragraph boundary (double newline)
  const paraBreak = text.lastIndexOf("\n\n", limit);
  if (paraBreak > limit * 0.3) return paraBreak + 2;

  // 2. Line break
  const lineBreak = text.lastIndexOf("\n", limit);
  if (lineBreak > limit * 0.3) return lineBreak + 1;

  // 3. Whitespace
  const spaceBreak = text.lastIndexOf(" ", limit);
  if (spaceBreak > limit * 0.3) return spaceBreak + 1;

  // 4. Hard cut
  return limit;
}

// ─── Code Fence Tracking ────────────────────────────────────────────────────

/**
 * Scan text for an unclosed fenced code block.
 * Returns the language tag of the open fence, or null if all fences are closed.
 */
function findUnclosedFence(text: string): { lang: string } | null {
  const fenceRegex = /^```(\w*)\s*$/gm;
  let openLang: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (openLang === null) {
      // Opening fence
      openLang = match[1];
    } else {
      // Closing fence
      openLang = null;
    }
  }

  return openLang !== null ? { lang: openLang } : null;
}
