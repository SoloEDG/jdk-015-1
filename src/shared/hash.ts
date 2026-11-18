/** Small helpers shared by show packages and the audio engine. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return bytesToHex(new Uint8Array(digest));
  }
  // Content addressing fallback for non-secure contexts (older browsers).
  // Scan in slices so hashing a large track cannot freeze the live canvas.
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  const slice = 4 * 1024 * 1024;
  for (let start = 0; start < bytes.length; start += slice) {
    const end = Math.min(bytes.length, start + slice);
    for (let i = start; i < end; i++) {
      h1 ^= bytes[i];
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (Math.imul(h2 ^ bytes[i], 0x85ebca6b) + i) >>> 0;
    }
    if (end < bytes.length)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return `fnv1a-${h1.toString(16).padStart(8, "0")}${h2
    .toString(16)
    .padStart(8, "0")}-${bytes.length.toString(16)}`;
}

const mimeExtensions: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
};

export function extensionFor(mime: string, name = ""): string {
  const clean = mime.split(";")[0].trim().toLowerCase();
  if (mimeExtensions[clean]) return mimeExtensions[clean];
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name);
  return fromName ? fromName[1].toLowerCase() : "bin";
}

export function safeFileName(name: string, fallback = "show"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
