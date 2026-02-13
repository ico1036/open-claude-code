import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "./chunk.js";

describe("chunkMarkdown", () => {
  it("returns single chunk when text is under limit", () => {
    const text = "Hello world";
    expect(chunkMarkdown(text, 100)).toEqual(["Hello world"]);
  });

  it("returns text as-is when exactly at limit", () => {
    const text = "a".repeat(100);
    expect(chunkMarkdown(text, 100)).toEqual([text]);
  });

  it("splits at paragraph boundary", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const chunks = chunkMarkdown(text, 25);
    expect(chunks).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("splits at line break when no paragraph boundary", () => {
    const text = "Line one.\nLine two is a bit longer.";
    const chunks = chunkMarkdown(text, 15);
    expect(chunks[0]).toBe("Line one.");
    expect(chunks[1]).toContain("Line two");
  });

  it("splits at whitespace when no line break", () => {
    const text = "word1 word2 word3 word4 word5";
    const chunks = chunkMarkdown(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20); // some slack for trimming
    }
  });

  it("hard-cuts when no good split point", () => {
    const text = "a".repeat(200);
    const chunks = chunkMarkdown(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(100);
    expect(chunks[1].length).toBe(100);
  });

  // ── Code Fence Handling ──

  it("closes and reopens code fence across chunks", () => {
    const code = "x\n".repeat(50).trim(); // 100 chars of code
    const text = `before\n\n\`\`\`python\n${code}\n\`\`\`\n\nafter`;
    const chunks = chunkMarkdown(text, 80);

    // First chunk should close the code fence
    const first = chunks[0];
    expect(first).toContain("```python");
    expect(first).toMatch(/```$/); // ends with closing fence

    // Second chunk should reopen the fence
    const second = chunks[1];
    expect(second).toMatch(/^```python/);
  });

  it("handles text with no code fences normally", () => {
    const text = "Hello world. ".repeat(50);
    const chunks = chunkMarkdown(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("```");
    }
  });

  it("handles already-closed code fence without modification", () => {
    const text = "```js\nconsole.log('hi');\n```\n\nSome text after.";
    const chunks = chunkMarkdown(text, 4000);
    expect(chunks).toEqual([text]);
  });

  it("uses default 4000 char limit", () => {
    const text = "x".repeat(8000);
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(4000);
  });
});
