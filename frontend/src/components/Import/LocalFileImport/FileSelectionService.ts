import { useImportStore } from "@/stores/useImportStore";
import type { FileImportChunk, LogSourceProviderService } from "../types";

export const PREVIEW_BYTES = 1 * 1024 * 1024;
export const READ_RANGE_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_PHYSICAL_LINE_BYTES = 2 * 1024 * 1024;

const utf8Decoder = () => new TextDecoder("utf-8");

function stripLeadingUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

const abortError = () => new DOMException("The file import was cancelled", "AbortError");

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

const jsonEscapePattern = new RegExp(
  '["\\\\' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1F) + ']',
);
const surrogatePattern = /[\uD800-\uDFFF]/;
const exactJsonSizeThreshold = 256 * 1024;

function serializedJsonStringByteLength(
  text: string,
  utf8Bytes: number,
  encoder: TextEncoder,
): number {
  if (!jsonEscapePattern.test(text) && !surrogatePattern.test(text)) {
    return utf8Bytes + 2; // surrounding quotes
  }

  // Avoid materializing a potentially 6x-expanded JSON string for large
  // escaped lines. The bound is exact for ASCII control characters and a
  // safe upper bound for all other UTF-16 input. It only makes chunking more
  // conservative; the request remains below the configured limit.
  if (text.length > exactJsonSizeThreshold) {
    return text.length * 6 + 2;
  }

  return encoder.encode(JSON.stringify(text)).byteLength;
}

function splitCompleteLines(text: string): { lines: string[]; remainder: string } {
  const parts = text.split("\n");
  const remainder = parts.pop() ?? "";
  return {
    // Preserve the historical import behavior: empty physical lines are not
    // sent to the ingest API. A lone CR is retained as content, while CRLF
    // is normalized to the same line representation as the old split regex.
    lines: parts.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line),
    remainder,
  };
}

function previewLineCount(lines: string[], remainder: string, bytesRead: number, totalBytes: number): number {
  const nonEmptyLines = lines.filter((line) => line.length > 0).length;
  if (totalBytes <= bytesRead || bytesRead === 0 || nonEmptyLines === 0) {
    return nonEmptyLines + (remainder.length > 0 ? 1 : 0);
  }
  return Math.max(1, Math.ceil(nonEmptyLines * totalBytes / bytesRead));
}

export async function readFilePreview(file: File): Promise<{ lines: string[]; approxLines: number }> {
  const bytesRead = Math.min(file.size, PREVIEW_BYTES);
  const buffer = await file.slice(0, bytesRead).arrayBuffer();
  const text = stripLeadingUtf8Bom(utf8Decoder().decode(buffer));
  const split = splitCompleteLines(text);
  const lines = bytesRead === file.size && split.remainder.length > 0
    ? [...split.lines, split.remainder]
    : split.lines;
  return {
    lines: lines.filter((line) => line.length > 0).slice(0, 100),
    approxLines: previewLineCount(split.lines, split.remainder, bytesRead, file.size),
  };
}

export async function streamFileChunks(
  file: File,
  chunkSize: number,
  callback: (chunk: FileImportChunk) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("File chunk size must be a positive integer");
  }

  const decoder = utf8Decoder();
  let byteOffset = 0;
  let remainder = "";
  let pendingLines: string[] = [];
  let strippedLeadingBom = false;
  const encoder = new TextEncoder();
  const sessionIDPlaceholder = "0".repeat(36);
  const emptyBody = JSON.stringify({ logs: [], session_id: sessionIDPlaceholder });
  const bodyPrefixBytes = encoder.encode(emptyBody).byteLength - 2;
  let pendingBodyBytes = bodyPrefixBytes;

  while (byteOffset < file.size) {
    throwIfAborted(signal);
    const nextOffset = Math.min(file.size, byteOffset + READ_RANGE_BYTES);
    const buffer = await file.slice(byteOffset, nextOffset).arrayBuffer();
    byteOffset = nextOffset;
    remainder += decoder.decode(buffer, { stream: byteOffset < file.size });
    if (!strippedLeadingBom) {
      remainder = stripLeadingUtf8Bom(remainder);
      strippedLeadingBom = remainder.length > 0 || byteOffset >= file.size;
    }

    const split = splitCompleteLines(remainder);
    remainder = split.remainder;
    if (encoder.encode(remainder).byteLength > MAX_PHYSICAL_LINE_BYTES) {
      throw new Error(`A log line exceeds the ${MAX_PHYSICAL_LINE_BYTES / (1024 * 1024)} MiB limit`);
    }
    for (const line of split.lines) {
      throwIfAborted(signal);
      if (line.length === 0) continue;
      const lineBytes = encoder.encode(line).byteLength;
      if (lineBytes > MAX_PHYSICAL_LINE_BYTES) {
        throw new Error(`A log line exceeds the ${MAX_PHYSICAL_LINE_BYTES / (1024 * 1024)} MiB limit`);
      }
      const serializedLineBytes = serializedJsonStringByteLength(line, lineBytes, encoder);
      if (bodyPrefixBytes + serializedLineBytes > MAX_CHUNK_BYTES) {
        throw new Error(`A log line cannot fit within the ${MAX_CHUNK_BYTES / (1024 * 1024)} MiB request limit`);
      }
      const nextBodyBytes = pendingBodyBytes + serializedLineBytes + (pendingLines.length > 0 ? 1 : 0);
      if (pendingLines.length > 0 && (
        pendingLines.length >= chunkSize || nextBodyBytes > bodyPrefixBytes + MAX_CHUNK_BYTES
      )) {
        throwIfAborted(signal);
        const lines = pendingLines;
        pendingLines = [];
        pendingBodyBytes = bodyPrefixBytes;
        await callback({ lines, bytesRead: byteOffset, totalBytes: file.size });
      }
      pendingLines.push(line);
      pendingBodyBytes += serializedLineBytes + (pendingLines.length > 1 ? 1 : 0);
    }
  }

  throwIfAborted(signal);
  remainder += decoder.decode();
  if (!strippedLeadingBom) {
    remainder = stripLeadingUtf8Bom(remainder);
  }
  if (remainder.length > 0) {
    const lineBytes = encoder.encode(remainder).byteLength;
    if (lineBytes > MAX_PHYSICAL_LINE_BYTES) {
      throw new Error(`A log line exceeds the ${MAX_PHYSICAL_LINE_BYTES / (1024 * 1024)} MiB limit`);
    }
    const serializedLineBytes = serializedJsonStringByteLength(remainder, lineBytes, encoder);
    if (bodyPrefixBytes + serializedLineBytes > MAX_CHUNK_BYTES) {
      throw new Error(`A log line cannot fit within the ${MAX_CHUNK_BYTES / (1024 * 1024)} MiB request limit`);
    }
    if (pendingLines.length > 0 && (
      pendingLines.length >= chunkSize
      || pendingBodyBytes + serializedLineBytes + 1 > bodyPrefixBytes + MAX_CHUNK_BYTES
    )) {
      throwIfAborted(signal);
      await callback({ lines: pendingLines, bytesRead: file.size, totalBytes: file.size });
      pendingLines = [];
      pendingBodyBytes = bodyPrefixBytes;
    }
    pendingLines.push(remainder);
  }

  if (pendingLines.length > 0) {
    throwIfAborted(signal);
    await callback({ lines: pendingLines, bytesRead: file.size, totalBytes: file.size });
  }
}

export const useFileSelectionService = (): LogSourceProviderService => {
  const importStore = useImportStore();

  const handleFilePreview = async (filehandle: object, onPreviewReadyCallback: (lines: string[]) => void) => {
    const file = filehandle as File;
    importStore.setSelectedFileHandle(file);
    const { lines, approxLines } = await readFilePreview(file);
    importStore.setApproxLines(approxLines);
    onPreviewReadyCallback(lines);
  };

  const handleFileImport = (
    filehandle: object,
    chunkSize: number,
    callback: (chunk: FileImportChunk) => Promise<void>,
    signal?: AbortSignal,
  ) => streamFileChunks(filehandle as File, chunkSize, callback, signal);

  return {
    name: "File",
    handleFilePreview,
    handleFileImport,
  };
};
