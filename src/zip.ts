/**
 * Hardened zip extraction for update packages (shared design with the Canvas
 * plugin): streaming decode with real size limits, no path traversal, no
 * symlinks, and name conflicts skipped rather than fatal.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Unzip, UnzipInflate } from "fflate";

const ZIP_MAX_ENTRIES = 2000;
const ZIP_MAX_TOTAL = 500 * 1024 * 1024;
const ZIP_MAX_ENTRY = 200 * 1024 * 1024;
const MAX_SKIPPED_NOTES = 100;
const MAX_NAME_BYTES = 200;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
function truncateBytes(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch);
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * A filesystem-safe name that cannot escape its directory or hide as a
 * dotfile, at most MAX_NAME_BYTES bytes, keeping a short extension.
 */
export function safeName(name: string): string {
  const cleaned =
    name
      .normalize("NFC")
      .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
      .replace(/^[.\s]+/, "")
      .trim() || "file";
  if (Buffer.byteLength(cleaned) <= MAX_NAME_BYTES) return cleaned;
  const ext = path.extname(cleaned);
  const keepExt = ext && Buffer.byteLength(ext) <= 16 ? ext : "";
  const base = keepExt ? cleaned.slice(0, -keepExt.length) : cleaned;
  return (
    truncateBytes(base, MAX_NAME_BYTES - Buffer.byteLength(keepExt)).trim() +
    keepExt
  );
}

/** Normalize a zip entry path, or return undefined if it is unsafe. */
export function safeZipEntryPath(entry: string): string | undefined {
  const unified = entry.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return undefined;
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(safeName(part));
  }
  if (!parts.length) return undefined;
  return parts.join("/");
}

/**
 * Unpack a zip with real (not declared) size limits. Streaming decode reads
 * each entry's actual data, so entries that lie about their size are neither
 * truncated nor allowed past the limits, and central-directory tricks that
 * repeat one entry are not amplified.
 */
export async function extractZip(
  data: Buffer,
  destination: string,
): Promise<{ files: string[]; skipped: string[] }> {
  const skippedNotes: string[] = [];
  let skippedCount = 0;
  const skip = (note: string) => {
    skippedCount++;
    if (skippedNotes.length < MAX_SKIPPED_NOTES) skippedNotes.push(note);
  };
  const decoded: { rel: string; name: string; chunks: Uint8Array[] }[] = [];
  let entries = 0;
  let total = 0;

  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/")) return;
    if (/(^|\/)(__MACOSX\/|\.DS_Store$)/.test(file.name)) return;
    entries++;
    if (entries > ZIP_MAX_ENTRIES) {
      skip(`${file.name} (too many entries)`);
      return;
    }
    const rel = safeZipEntryPath(file.name);
    if (!rel) {
      skip(`${file.name} (unsafe path)`);
      return;
    }
    const entry = { rel, name: file.name, chunks: [] as Uint8Array[] };
    let size = 0;
    let dropped = false;
    file.ondata = (error, chunk, final) => {
      if (dropped) return;
      if (error) {
        dropped = true;
        skip(`${file.name} (corrupt: ${error.message})`);
        return;
      }
      size += chunk.byteLength;
      total += chunk.byteLength;
      if (size > ZIP_MAX_ENTRY || total > ZIP_MAX_TOTAL) {
        dropped = true;
        total -= size;
        entry.chunks = [];
        skip(
          `${file.name} (${size > ZIP_MAX_ENTRY ? "too large" : "archive too large"})`,
        );
        file.terminate();
        return;
      }
      entry.chunks.push(chunk);
      if (final) decoded.push(entry);
    };
    try {
      file.start();
    } catch (error) {
      skip(`${file.name} (unsupported: ${(error as Error).message})`);
    }
  });
  unzip.register(UnzipInflate);
  let failure: Error | undefined;
  try {
    unzip.push(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      true,
    );
  } catch (error) {
    failure = error as Error;
  }
  if (failure && !decoded.length)
    throw new Error(`Could not read the zip file: ${failure.message}`);
  if (failure)
    skip(`(the rest of the archive could not be read: ${failure.message})`);

  const files: string[] = [];
  const root = path.resolve(destination);
  await fs.mkdir(root, { recursive: true, mode: DIR_MODE });
  for (const entry of decoded) {
    const target = path.resolve(root, entry.rel);
    if (!target.startsWith(root + path.sep)) {
      skip(`${entry.name} (unsafe path)`);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(target), {
        recursive: true,
        mode: DIR_MODE,
      });
      await fs.writeFile(target, Buffer.concat(entry.chunks), {
        flag: "wx",
        mode: FILE_MODE,
      });
      files.push(entry.rel);
    } catch (error: any) {
      // A file and a folder with the same name, or a repeated name: keep the
      // first one and report the rest instead of failing the whole archive.
      if (!["EEXIST", "ENOTDIR", "EISDIR"].includes(error?.code)) throw error;
      skip(`${entry.name} (name conflicts with another entry)`);
    }
  }
  if (skippedCount > skippedNotes.length)
    skippedNotes.push(`… and ${skippedCount - skippedNotes.length} more`);
  return { files: files.sort(), skipped: skippedNotes };
}

