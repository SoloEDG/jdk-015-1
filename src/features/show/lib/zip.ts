import { inflateSync } from "fflate";

export interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  originalSize: number;
  localOffset: number;
  dataOffset: number;
  crc: number;
}

const u16 = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>>
  0;
const u64 = (bytes: Uint8Array, offset: number) =>
  u32(bytes, offset) + u32(bytes, offset + 4) * 0x100000000;

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const TAIL = 66000;
const ZIP64_SENTINEL = 0xffffffff;

export const normalizePath = (path: string) =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();

async function readRange(file: Blob, start: number, end: number) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function locateDataOffset(file: Blob, entry: ZipEntry) {
  const header = await readRange(
    file,
    entry.localOffset,
    Math.min(entry.localOffset + 1024, entry.localOffset + 30 + 65535 + 65535),
  );
  if (header.length < 30 || u32(header, 0) !== LOCAL) return -1;
  const nameLength = u16(header, 26);
  const extraLength = u16(header, 28);
  return entry.localOffset + 30 + nameLength + extraLength;
}

export class ZipReader {
  private constructor(
    readonly file: Blob,
    readonly entries: Map<string, ZipEntry>,
  ) {}

  static async open(file: Blob): Promise<ZipReader | null> {
    if (file.size < 22) return null;
    const tailStart = Math.max(0, file.size - TAIL);
    const tail = await readRange(file, tailStart, file.size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (u32(tail, i) === EOCD) {
        eocd = i;
        break;
      }
    if (eocd < 0) return null;
    let count = u16(tail, eocd + 10);
    let centralSize = u32(tail, eocd + 12);
    let centralOffset = u32(tail, eocd + 16);
    if (eocd >= 20 && u32(tail, eocd - 20) === ZIP64_LOCATOR) {
      const zip64Offset = u64(tail, eocd - 12);
      const zip64 = await readRange(file, zip64Offset, zip64Offset + 56);
      if (zip64.length >= 56 && u32(zip64, 0) === ZIP64_EOCD) {
        count = u64(zip64, 32);
        centralSize = u64(zip64, 40);
        centralOffset = u64(zip64, 48);
      }
    }
    if (
      centralOffset + centralSize > file.size ||
      centralSize <= 0 ||
      count <= 0
    )
      return null;
    const central = await readRange(
      file,
      centralOffset,
      centralOffset + centralSize,
    );
    const entries = new Map<string, ZipEntry>();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= central.length; i++) {
      if (u32(central, p) !== CENTRAL) return null;
      const compression = u16(central, p + 10);
      const crc = u32(central, p + 16);
      const compressedSize = u32(central, p + 20);
      const originalSize = u32(central, p + 24);
      const nameLength = u16(central, p + 28);
      const extraLength = u16(central, p + 30);
      const commentLength = u16(central, p + 32);
      const localOffset = u32(central, p + 42);
      const name = new TextDecoder().decode(
        central.subarray(p + 46, p + 46 + nameLength),
      );
      p += 46 + nameLength + extraLength + commentLength;
      if (
        compressedSize === ZIP64_SENTINEL ||
        originalSize === ZIP64_SENTINEL ||
        localOffset === ZIP64_SENTINEL
      )
        throw new Error("演出包使用了 ZIP64 结构，暂不支持打开。");
      const entry: ZipEntry = {
        name,
        compression,
        compressedSize,
        originalSize,
        localOffset,
        dataOffset: -1,
        crc,
      };
      const key = normalizePath(name);
      if (!entries.has(key)) entries.set(key, entry);
    }
    return entries.size ? new ZipReader(file, entries) : null;
  }

  has(path: string) {
    return this.entries.has(normalizePath(path));
  }

  entry(path: string) {
    return this.entries.get(normalizePath(path));
  }

  private async prepared(entry: ZipEntry) {
    if (entry.dataOffset < 0) {
      entry.dataOffset = await locateDataOffset(this.file, entry);
      if (entry.dataOffset < 0) throw new Error("演出包结构异常，无法读取素材。");
    }
    return entry;
  }

  /** Reads and (if needed) inflates one entry. Manifest files are small. */
  async read(path: string): Promise<Uint8Array> {
    const entry = this.entry(path);
    if (!entry) throw new Error("演出包缺少所需文件。");
    await this.prepared(entry);
    const raw = await readRange(
      this.file,
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    );
    if (entry.compression === 0) return raw;
    if (entry.compression !== 8)
      throw new Error("演出包使用了不受支持的压缩方式，无法读取。");
    try {
      return inflateSync(raw, { out: new Uint8Array(entry.originalSize) });
    } catch {
      throw new Error("演出包内的文件已损坏，无法读取。");
    }
  }

  /**
   * Copies a stored entry in slices, yielding to the browser between slices so
   * a multi-hundred-megabyte track never holds up the live canvas.
   */
  async copy(
    entry: ZipEntry,
    sliceSize: number,
    onProgress: (copied: number, total: number) => void,
    yieldFrame: () => Promise<void>,
  ): Promise<Uint8Array> {
    const target = await this.prepared(entry);
    const total = target.originalSize || target.compressedSize;
    const out = new Uint8Array(total);
    if (target.compression !== 0) {
      // Foreign tools may deflate; inflate in one step (manifest-only path in
      // practice) and still report final progress.
      const raw = await this.read(target.name);
      if (raw.length > total) {
        onProgress(total, total);
        return raw.subarray(0, total);
      }
      out.set(raw);
      onProgress(total, total);
      return out;
    }
    for (let offset = 0; offset < total; offset += sliceSize) {
      const end = Math.min(total, offset + sliceSize);
      const part = await readRange(this.file, target.dataOffset + offset, target.dataOffset + end);
      out.set(part.subarray(0, end - offset), offset);
      onProgress(end, total);
      if (end < total) await yieldFrame();
    }
    return out;
  }
}
