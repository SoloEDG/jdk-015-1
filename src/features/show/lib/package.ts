import { Zip, ZipPassThrough } from "fflate";
import type {
  AudioAsset,
  Scene,
  SceneKind,
  StageDocument,
} from "../../../shared/types";
import { extensionFor, safeFileName, sha256 } from "../../../shared/hash";
import { uid } from "../../../shared/document";
import {
  buildManifest,
  parseManifest,
  type ParsedAsset,
  type ParsedManifest,
  type ParsedScene,
} from "./manifest";
import { normalizePath, ZipReader, type ZipEntry } from "./zip";
import type { AudioEngine } from "../../audio/model/engine";

export const PACKAGE_EXTENSION = ".resonance.show.zip";
const MANIFEST_CANDIDATES = ["show.json", "manifest.json", "resonance.json"];
const CHUNK_SIZE = 1.5 * 1024 * 1024;

export interface ExportProgress {
  phase: string;
  completed: number;
  total: number;
  ratio: number;
}

export interface ExportedPackage {
  blob: Blob;
  fileName: string;
  warnings: string[];
}

export interface Replacement {
  file: File;
  blob: Blob;
  hash: string;
  duration: number;
  buffer: AudioBuffer;
}

export interface MissingAsset {
  key: string;
  name: string;
  mime: string;
  referencedBy: string[];
  path?: string;
}

export interface ReadProgress {
  phase: string;
  completed: number;
  total: number;
  ratio: number;
}

export interface Inspection {
  token: number;
  fileName: string;
  reader: ZipReader;
  parsed: ParsedManifest;
  missing: MissingAsset[];
  usedAssetKeys: string[];
  fatal: string[];
  warnings: string[];
  manifestPath: string;
  manifestAssets: Map<string, ParsedAsset>;
  totalAssetBytes: number;
}

export const yieldToBrowser = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/** Packages are built in slices so a large track never stalls the live stage. */
export async function exportPackage(
  doc: StageDocument,
  assets: AudioAsset[],
  onProgress: (progress: ExportProgress) => void,
): Promise<ExportedPackage> {
  const { manifest, warnings } = buildManifest(doc, assets);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(manifest, null, 2),
  );
  const unique = new Map<string, { path: string; blob: Blob; name: string }>();
  const blobsByHash = new Map(assets.map((asset) => [asset.hash, asset]));
  manifest.assets.forEach((entry) => {
    const asset = blobsByHash.get(entry.hash);
    if (!asset || unique.has(entry.path)) return;
    unique.set(entry.path, {
      path: entry.path,
      blob: asset.blob,
      name: asset.name,
    });
  });
  const total =
    manifestBytes.length +
    [...unique.values()].reduce((sum, file) => sum + file.blob.size, 0);
  let completed = 0;

  return new Promise<ExportedPackage>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("打包失败，请重试。"));
    };
    const zip = new Zip((error, chunk, final) => {
      if (error) return fail();
      if (chunk?.length) chunks.push(chunk);
      if (final && !settled) {
        settled = true;
        resolve({
          blob: new Blob(chunks as BlobPart[], { type: "application/zip" }),
          fileName: `${safeFileName(doc.showName, "Untitled session")}${PACKAGE_EXTENSION}`,
          warnings,
        });
      }
    });

    const emit = (phase: string) =>
      onProgress({
        phase,
        completed,
        total,
        ratio: total ? completed / total : 0,
      });

    const manifestFile = new ZipPassThrough("show.json");
    zip.add(manifestFile);
    manifestFile.push(manifestBytes, true);
    completed += manifestBytes.length;
    emit("写入演出清单");

    void (async () => {
      try {
        for (const file of unique.values()) {
          const entry = new ZipPassThrough(file.path);
          zip.add(entry);
          emit(`打包 ${file.name}`);
          if (!file.blob.size) {
            entry.push(new Uint8Array(0), true);
            continue;
          }
          for (let start = 0; start < file.blob.size; start += CHUNK_SIZE) {
            const end = Math.min(file.blob.size, start + CHUNK_SIZE);
            const part = new Uint8Array(
              await file.blob.slice(start, end).arrayBuffer(),
            );
            const last = end >= file.blob.size;
            entry.push(part, last);
            completed += part.length;
            emit(`打包 ${file.name}`);
            if (!last) await yieldToBrowser();
          }
        }
        emit("生成压缩包");
        zip.end();
      } catch {
        fail();
      }
    })();
  });
}

export function resolveAssetPath(manifestPath: string, assetPath: string) {
  const clean = assetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (clean.startsWith("/")) return normalizePath(clean);
  const base = manifestPath.includes("/")
    ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1)
    : "";
  return normalizePath(base + clean);
}

const SHA256 = /^[a-f0-9]{64}$/i;

/**
 * Reads the manifest and the archive index only. Audio is not touched yet, so
 * opening is quick and the live stage keeps rendering while we inspect.
 */
export async function inspectPackage(
  file: File,
  token: number,
  onProgress?: (progress: ReadProgress) => void,
): Promise<Inspection> {
  if (!file.size) throw new Error("文件为空，无法打开。");
  onProgress?.({ phase: "读取压缩包目录", completed: 0, total: file.size, ratio: 0 });
  const reader = await ZipReader.open(file);
  if (!reader)
    throw new Error("无法读取压缩包，文件可能损坏或不是有效的演出包。");
  const manifestKey =
    MANIFEST_CANDIDATES.find((name) => reader.has(name)) ??
    [...reader.entries.keys()].find(
      (key) => key.endsWith(".json") && !key.startsWith("audio/"),
    );
  if (!manifestKey)
    throw new Error("演出包缺少 show.json 清单，无法识别此演出。");
  onProgress?.({
    phase: "解析演出清单",
    completed: Math.min(file.size, 64 * 1024),
    total: file.size,
    ratio: 0.05,
  });
  const manifestBytes = await reader.read(manifestKey);
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder().decode(manifestBytes).replace(/^﻿/, ""),
    );
  } catch {
    throw new Error("演出包清单不是有效的 JSON，文件可能已损坏。");
  }
  const parsed = parseManifest(raw, file.name);
  const fatal = parsed.issues
    .filter((issue) => issue.level === "fatal")
    .map((issue) => issue.message);
  // Structurally presented blocks (unsupported scenes, missing audio) carry
  // their own detail; don't repeat them in the free-form warning list.
  const warnings = parsed.issues
    .filter(
      (issue) =>
        issue.level === "warning" &&
        issue.code !== "scene-kind-unsupported",
    )
    .map((issue) => issue.message);

  const manifestAssets = new Map<string, ParsedAsset>();
  const byHash = new Map<string, ParsedAsset>();
  parsed.assets.forEach((asset) => {
    if (!manifestAssets.has(asset.key)) manifestAssets.set(asset.key, asset);
    if (asset.hash && !byHash.has(asset.hash)) byHash.set(asset.hash, asset);
  });

  const referenced = new Map<
    string,
    { asset?: ParsedAsset; scenes: string[] }
  >();
  parsed.scenes.forEach((scene) => {
    if (!scene.supported || !scene.audioKey) return;
    const asset =
      manifestAssets.get(scene.audioKey) ?? byHash.get(scene.audioKey);
    const key = asset?.key ?? scene.audioKey;
    const current = referenced.get(key) ?? { asset, scenes: [] };
    if (!current.asset) current.asset = asset;
    current.scenes.push(scene.name);
    referenced.set(key, current);
  });

  const missing: MissingAsset[] = [];
  let totalAssetBytes = 0;
  const usedAssetKeys: string[] = [];
  referenced.forEach((reference, key) => {
    usedAssetKeys.push(key);
    const asset = reference.asset;
    if (asset) totalAssetBytes += asset.size;
    const path = asset
      ? resolveAssetPath(reader.entry(manifestKey)!.name, asset.path)
      : "";
    const entry: ZipEntry | undefined = path ? reader.entry(path) : undefined;
    const present = !!entry && entry.originalSize > 0;
    if (!asset) {
      missing.push({
        key,
        name: key,
        mime: "audio/*",
        referencedBy: reference.scenes,
        path: path || undefined,
      });
      warnings.push("有场景引用了清单中不存在的音频，需要重新指定音频。");
    } else if (!present) {
      missing.push({
        key,
        name: asset.name,
        mime: asset.mime || "audio/*",
        referencedBy: reference.scenes,
        path: path || undefined,
      });
      if (entry && entry.originalSize === 0)
        warnings.push(`素材“${asset.name}”在包内为空文件。`);
    }
  });

  const unused = parsed.assets.filter(
    (asset) => !usedAssetKeys.includes(asset.key),
  );
  if (unused.length)
    warnings.push(
      `包内有 ${unused.length} 个未被场景引用的音频素材，打开时会忽略。`,
    );

  onProgress?.({
    phase: "检查可用素材",
    completed: file.size,
    total: file.size,
    ratio: 1,
  });
  return {
    token,
    fileName: file.name,
    reader,
    parsed,
    missing,
    usedAssetKeys,
    fatal: [...new Set(fatal)],
    warnings: [...new Set(warnings)],
    manifestPath: reader.entry(manifestKey)!.name,
    manifestAssets,
    totalAssetBytes,
  };
}

export interface ImportedShow {
  document: StageDocument;
  assets: { asset: AudioAsset; buffer: AudioBuffer }[];
  showName: string;
}

function sceneFromParsed(scene: ParsedScene, audioId: string | null): Scene {
  return {
    id: scene.id,
    name: scene.name,
    kind: scene.kind as SceneKind,
    theme: scene.theme,
    intensity: scene.intensity,
    speed: scene.speed,
    audioId,
    audioGain: scene.audioGain,
    audioOffset: scene.audioOffset,
  };
}

/**
 * Extracts, decodes and verifies every asset before anything touches the live
 * show. Any failure throws, leaving the old show, audio and takes untouched.
 */
export async function buildImportedShow(
  inspection: Inspection,
  audio: AudioEngine,
  skipped: string[] = [],
  replacements: Record<string, Replacement> = {},
  onProgress?: (progress: ReadProgress) => void,
): Promise<ImportedShow> {
  const parsed = inspection.parsed;
  if (inspection.fatal.length) throw new Error(inspection.fatal[0]);
  const unresolved = inspection.missing.filter(
    (item) => !replacements[item.key] && !skipped.includes(item.key),
  );
  if (unresolved.length)
    throw new Error("仍有缺失的音频未替换，无法打开演出。");

  const createdUrls: string[] = [];
  const byHash = new Map<string, { asset: AudioAsset; buffer: AudioBuffer }>();
  const byKey = new Map<string, string>();
  const adopted: { asset: AudioAsset; buffer: AudioBuffer }[] = [];

  const register = (
    key: string,
    blob: Blob,
    hash: string,
    buffer: AudioBuffer,
    name: string,
    mime: string,
    origin: AudioAsset["origin"],
  ) => {
    let record = byHash.get(hash);
    if (!record) {
      const url = URL.createObjectURL(blob);
      createdUrls.push(url);
      record = {
        asset: {
          id: hash,
          hash,
          name,
          mime,
          size: blob.size,
          duration: buffer.duration,
          blob,
          url,
          origin,
        },
        buffer,
      };
      byHash.set(hash, record);
      adopted.push(record);
    }
    byKey.set(key, hash);
  };

  const queue = inspection.usedAssetKeys.filter(
    (key) => !skipped.includes(key),
  );
  let completed = 0;
  const total = queue.reduce((sum, key) => {
    const replacement = replacements[key];
    if (replacement) return sum + replacement.blob.size;
    const asset = inspection.manifestAssets.get(key);
    const entry = asset
      ? inspection.reader.entry(
          resolveAssetPath(inspection.manifestPath, asset.path),
        )
      : undefined;
    return sum + (entry?.originalSize ?? asset?.size ?? 0);
  }, 0);
  const emit = (phase: string) =>
    onProgress?.({
      phase,
      completed,
      total,
      ratio: total ? completed / total : 0,
    });

  try {
    for (const key of inspection.usedAssetKeys) {
      const replacement = replacements[key];
      if (skipped.includes(key) && !replacement) continue;
      if (replacement) {
        const { blob, buffer, file, hash } = replacement;
        register(
          key,
          blob,
          hash,
          buffer,
          file.name,
          file.type || "audio/*",
          "local",
        );
        completed += blob.size;
        emit(`准备替换素材 ${file.name}`);
        continue;
      }
      const asset = inspection.manifestAssets.get(key);
      if (!asset) throw new Error("演出包清单引用了不存在的音频素材。");
      const path = resolveAssetPath(inspection.manifestPath, asset.path);
      const entry = inspection.reader.entry(path);
      if (!entry || entry.originalSize === 0)
        throw new Error(`演出包中缺少素材“${asset.name}”。`);
      emit(`读取素材 ${asset.name}`);
      let copiedBefore = 0;
      const data = await inspection.reader.copy(
        entry,
        4 * 1024 * 1024,
        (copied) => {
          completed += copied - copiedBefore;
          copiedBefore = copied;
          emit(`读取素材 ${asset.name}`);
        },
        yieldToBrowser,
      );
      const blob = new Blob([data as BlobPart], {
        type: asset.mime || "audio/*",
      });
      const hash = await sha256(blob);
      if (SHA256.test(asset.hash) && asset.hash.toLowerCase() !== hash)
        throw new Error(`素材“${asset.name}”校验失败，文件内容与清单不一致。`);
      let buffer: AudioBuffer;
      try {
        buffer = await audio.decode(blob);
      } catch {
        throw new Error(
          `无法解码素材“${asset.name}”，此浏览器可能不支持该音频格式。`,
        );
      }
      register(
        key,
        blob,
        hash,
        buffer,
        asset.name,
        asset.mime || "audio/*",
        "package",
      );
      emit(`解码素材 ${asset.name}`);
    }

    const scenes = parsed.scenes
      .filter((scene) => scene.supported)
      .map((scene) => {
        if (!scene.audioKey) return sceneFromParsed(scene, null);
        const id = byKey.get(scene.audioKey);
        if (!id) return sceneFromParsed(scene, null);
        return sceneFromParsed(scene, id);
      });
    if (!scenes.length) throw new Error("演出包中没有可用的场景。");
    const activeId = scenes.some((scene) => scene.id === parsed.activeSceneId)
      ? parsed.activeSceneId
      : scenes[0].id;
    const performance = parsed.performance;
    const document: StageDocument = {
      showId: parsed.showId || uid("show"),
      showName: parsed.showName,
      scenes,
      activeId,
      gain: performance.gain,
      sensitivity: performance.sensitivity,
      smoothing: performance.smoothing,
      transition: performance.transition,
      blackout: performance.blackout,
      frozen: performance.frozen,
      strobe: performance.strobe,
      master: performance.master,
      bpm: performance.bpm,
    };
    return { document, assets: adopted, showName: parsed.showName };
  } catch (error) {
    createdUrls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
}
