import { describe, expect, it } from "vitest";
import {
  MAX_PHYSICAL_LINE_BYTES,
  READ_RANGE_BYTES,
  readFilePreview,
  streamFileChunks,
} from "./FileSelectionService";

describe("streamFileChunks", () => {
  it("preserves UTF-8, CRLF boundaries, empty-line behavior, and order", async () => {
    // Put the first byte of a four-byte code point at the end of the first
    // read range, while keeping every physical line well below the limit.
    const prefix = "a\n".repeat(Math.floor((READ_RANGE_BYTES - 1) / 2));
    const file = new File([`${prefix}a🙂\r\nsecond\n\nthird`], "logs.txt");
    const chunks: string[][] = [];

    await streamFileChunks(file, 2, async ({ lines }) => {
      chunks.push(lines);
    });

    const lines = chunks.flat();
    expect(lines.slice(-3)).toEqual(["a🙂", "second", "third"]);
    expect(lines.length).toBe(Math.floor((READ_RANGE_BYTES - 1) / 2) + 3);
    expect(chunks[0]).toHaveLength(2);
  });

  it("reports byte progress and keeps one request below the client chunk cap", async () => {
    const file = new File(["one\ntwo\nthree\nfour\n"], "logs.txt");
    const progress: Array<{ bytesRead: number; totalBytes: number; count: number }> = [];

    await streamFileChunks(file, 2, async ({ lines, bytesRead, totalBytes }) => {
      progress.push({ bytesRead, totalBytes, count: lines.length });
    });

    expect(progress).toEqual([
      { bytesRead: file.size, totalBytes: file.size, count: 2 },
      { bytesRead: file.size, totalBytes: file.size, count: 2 },
    ]);
  });

  it("stops on cancellation before reading the next range", async () => {
    const file = new File(["line\n".repeat(READ_RANGE_BYTES)], "logs.txt");
    const controller = new AbortController();
    let callbacks = 0;

    await expect(streamFileChunks(file, 1, async () => {
      callbacks += 1;
      controller.abort();
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(callbacks).toBe(1);
  });

  it("rejects a physical line above the bounded line size", async () => {
    const file = new File(["x".repeat(MAX_PHYSICAL_LINE_BYTES + 1)], "logs.txt");

    await expect(streamFileChunks(file, 10, async () => undefined))
      .rejects.toThrow("2 MiB limit");
  });
});

describe("readFilePreview", () => {
  it("returns at most the first 100 non-empty lines", async () => {
    const file = new File([Array.from({ length: 150 }, (_, i) => `line-${i}`).join("\n")], "logs.txt");

    const preview = await readFilePreview(file);

    expect(preview.lines).toHaveLength(100);
    expect(preview.lines[0]).toBe("line-0");
    expect(preview.lines[99]).toBe("line-99");
    expect(preview.approxLines).toBe(150);
  });

  it("includes a short file without a trailing newline", async () => {
    const preview = await readFilePreview(new File(["single line"], "logs.txt"));

    expect(preview).toEqual({ lines: ["single line"], approxLines: 1 });
  });

  it("strips a UTF-8 BOM from the first line", async () => {
    const body = new TextEncoder().encode("error started\nsecond");
    const bytes = new Uint8Array(3 + body.length);
    bytes.set([0xEF, 0xBB, 0xBF], 0);
    bytes.set(body, 3);
    const file = new File([bytes], "logs.txt");

    const preview = await readFilePreview(file);
    expect(preview.lines).toEqual(["error started", "second"]);

    const chunks: string[] = [];
    await streamFileChunks(file, 10, async ({ lines }) => {
      chunks.push(...lines);
    });
    expect(chunks).toEqual(["error started", "second"]);
  });
});
