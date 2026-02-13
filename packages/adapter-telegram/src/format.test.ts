import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, escapeHtml } from "./format.js";

describe("escapeHtml", () => {
  it("escapes &, <, >", () => {
    expect(escapeHtml('a & b < c > d')).toBe("a &amp; b &lt; c &gt; d");
  });

  it("leaves normal text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("markdownToTelegramHtml", () => {
  // ── Code Blocks ──
  describe("code blocks", () => {
    it("converts fenced code block with language", () => {
      const md = '```python\nprint("hello")\n```';
      expect(markdownToTelegramHtml(md)).toBe(
        '<pre><code class="language-python">print("hello")</code></pre>',
      );
    });

    it("converts fenced code block without language", () => {
      const md = "```\nsome code\n```";
      expect(markdownToTelegramHtml(md)).toBe(
        "<pre><code>some code</code></pre>",
      );
    });

    it("escapes HTML inside code blocks", () => {
      const md = "```\n<div>test</div>\n```";
      expect(markdownToTelegramHtml(md)).toBe(
        "<pre><code>&lt;div&gt;test&lt;/div&gt;</code></pre>",
      );
    });

    it("handles multiline code blocks", () => {
      const md = "```js\nconst a = 1;\nconst b = 2;\n```";
      expect(markdownToTelegramHtml(md)).toBe(
        '<pre><code class="language-js">const a = 1;\nconst b = 2;</code></pre>',
      );
    });

    it("handles unclosed code block", () => {
      const md = "```python\nprint('hi')";
      expect(markdownToTelegramHtml(md)).toBe(
        "<pre><code class=\"language-python\">print('hi')</code></pre>",
      );
    });

    it("does not apply inline formatting inside code blocks", () => {
      const md = "```\n**bold** and *italic*\n```";
      expect(markdownToTelegramHtml(md)).toBe(
        "<pre><code>**bold** and *italic*</code></pre>",
      );
    });
  });

  // ── Inline Code ──
  describe("inline code", () => {
    it("converts inline code", () => {
      expect(markdownToTelegramHtml("use `npm install`")).toBe(
        "use <code>npm install</code>",
      );
    });

    it("escapes HTML inside inline code", () => {
      expect(markdownToTelegramHtml("type `<string>`")).toBe(
        "type <code>&lt;string&gt;</code>",
      );
    });

    it("does not apply formatting inside inline code", () => {
      expect(markdownToTelegramHtml("`**not bold**`")).toBe(
        "<code>**not bold**</code>",
      );
    });
  });

  // ── Bold ──
  describe("bold", () => {
    it("converts **bold**", () => {
      expect(markdownToTelegramHtml("**bold text**")).toBe("<b>bold text</b>");
    });

    it("converts __bold__", () => {
      expect(markdownToTelegramHtml("__bold text__")).toBe("<b>bold text</b>");
    });
  });

  // ── Italic ──
  describe("italic", () => {
    it("converts *italic*", () => {
      expect(markdownToTelegramHtml("*italic text*")).toBe("<i>italic text</i>");
    });

    it("converts _italic_ (not surrounded by alnum)", () => {
      expect(markdownToTelegramHtml("this is _italic_ text")).toBe(
        "this is <i>italic</i> text",
      );
    });

    it("does not convert underscores in identifiers", () => {
      expect(markdownToTelegramHtml("file_name_here")).toBe("file_name_here");
    });
  });

  // ── Strikethrough ──
  describe("strikethrough", () => {
    it("converts ~~text~~", () => {
      expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>");
    });
  });

  // ── Spoiler ──
  describe("spoiler", () => {
    it("converts ||text||", () => {
      expect(markdownToTelegramHtml("||spoiler||")).toBe(
        "<tg-spoiler>spoiler</tg-spoiler>",
      );
    });
  });

  // ── Links ──
  describe("links", () => {
    it("converts [text](url)", () => {
      expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
        '<a href="https://example.com">click</a>',
      );
    });

    it("handles links with query params", () => {
      const md = "[link](https://example.com?a=1&b=2)";
      expect(markdownToTelegramHtml(md)).toBe(
        '<a href="https://example.com?a=1&amp;b=2">link</a>',
      );
    });
  });

  // ── Blockquote ──
  describe("blockquote", () => {
    it("converts single-line blockquote", () => {
      expect(markdownToTelegramHtml("> quoted text")).toBe(
        "<blockquote>quoted text</blockquote>",
      );
    });

    it("coalesces consecutive blockquote lines", () => {
      const md = "> line 1\n> line 2\n> line 3";
      expect(markdownToTelegramHtml(md)).toBe(
        "<blockquote>line 1\nline 2\nline 3</blockquote>",
      );
    });

    it("separates blockquote from regular text", () => {
      const md = "> quote\nregular";
      expect(markdownToTelegramHtml(md)).toBe(
        "<blockquote>quote</blockquote>\nregular",
      );
    });
  });

  // ── Headers ──
  describe("headers", () => {
    it("converts # header to bold", () => {
      expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    });

    it("converts ## header to bold", () => {
      expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
    });

    it("applies inline formatting inside headers", () => {
      expect(markdownToTelegramHtml("## The `code` header")).toBe(
        "<b>The <code>code</code> header</b>",
      );
    });
  });

  // ── Combined ──
  describe("combined formatting", () => {
    it("handles mixed text with code block", () => {
      const md = "Here is code:\n\n```python\ndef hello():\n    pass\n```\n\nDone.";
      const expected = [
        "Here is code:",
        "",
        '<pre><code class="language-python">def hello():\n    pass</code></pre>',
        "",
        "Done.",
      ].join("\n");
      expect(markdownToTelegramHtml(md)).toBe(expected);
    });

    it("handles bold with inline code", () => {
      expect(markdownToTelegramHtml("**run** `npm test`")).toBe(
        "<b>run</b> <code>npm test</code>",
      );
    });

    it("escapes HTML in regular text", () => {
      expect(markdownToTelegramHtml("1 < 2 & 3 > 0")).toBe(
        "1 &lt; 2 &amp; 3 &gt; 0",
      );
    });
  });
});
