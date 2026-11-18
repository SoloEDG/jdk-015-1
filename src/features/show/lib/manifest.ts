import type { AudioAsset, SceneKind, StageDocument } from "../../../shared/types";
import { extensionFor, safeFileName } from "../../../shared/hash";
import { clamp } from "../../../shared/math";
import { themes } from "../../visuals/model/themes";

/** `resonance.show` packages: a zip with show.json plus content-addressed audio. */
export const PACKAGE_FORMAT = "resonance.show";
export const PACKAGE_VERSION = 2;
export const SUPPORTED_VERSIONS = [1, 2];
export const SUPPORTED_KINDS: SceneKind[] = [
  "orbit",
  "spectrum",
  "wave",
  "tunnel",
];

export interface PerformanceSettings {
  bpm: number;
  master: number;
  gain: number;
  sensitivity: number;
  smoothing: number;
  transition: number;
  strobe: boolean;
  blackout: boolean;
  frozen: boolean;
}

export const defaultPerformance: PerformanceSettings = {
  bpm: 120,
  master: 1,
  gain: 0.65,
  sensitivity: 1.2,
  smoothing: 0.78,
  transition: 1.2,
  strobe: false,
  blackout: false,
  frozen: false,
};

export interface ManifestAsset {
  id: string;
  hash: string;
  name: string;
  mime: string;
  size: number;
  duration: number;
  path: string;
}

export interface ManifestScene {
  id: string;
  name: string;
  kind: SceneKind;
  theme: string;
  intensity: number;
  speed: number;
  audio: { assetId: string | null; gain: number; offset: number };
}

export interface ShowManifest {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  createdAt: string;
  app: { name: string; version: string };
  show: {
    id: string;
    name: string;
    activeSceneId: string;
  };
  performance: PerformanceSettings;
  scenes: ManifestScene[];
  assets: ManifestAsset[];
}

export interface ShowIssue {
  code: string;
  level: "fatal" | "blocking" | "warning";
  message: string;
  sceneNames?: string[];
}

export interface ParsedScene {
  id: string;
  name: string;
  kind: SceneKind;
  requestedKind: string;
  supported: boolean;
  theme: string;
  intensity: number;
  speed: number;
  audioKey: string | null;
  audioGain: number;
  audioOffset: number;
}

export interface ParsedAsset {
  key: string;
  hash: string;
  name: string;
  mime: string;
  size: number;
  duration: number;
  path: string;
}

export interface ParsedManifest {
  fileName: string;
  showId: string;
  showName: string;
  activeSceneId: string;
  version: number;
  createdAt: string;
  performance: PerformanceSettings;
  scenes: ParsedScene[];
  assets: ParsedAsset[];
  issues: ShowIssue[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback = "") =>
  typeof v === "string" ? v : fallback;
const number = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback: boolean) =>
  typeof v === "boolean" ? v : fallback;

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}

export function buildManifest(
  doc: StageDocument,
  assets: AudioAsset[],
): { manifest: ShowManifest; warnings: string[] } {
  const unique = new Map<string, ManifestAsset>();
  assets.forEach((asset) => {
    if (unique.has(asset.hash)) return;
    unique.set(asset.hash, {
      id: asset.id,
      hash: asset.hash,
      name: asset.name,
      mime: asset.mime,
      size: asset.size,
      duration: asset.duration,
      path: `audio/${asset.hash}.${extensionFor(asset.mime, asset.name)}`,
    });
  });
  const warnings: string[] = [];
  const scenes: ManifestScene[] = doc.scenes.map((scene) => {
    const available = scene.audioId ? unique.has(scene.audioId) : false;
    if (scene.audioId && !available)
      warnings.push(`场景“${scene.name}”的音频素材不可用，将以无音频方式保存。`);
    return {
      id: scene.id,
      name: scene.name,
      kind: scene.kind,
      theme: scene.theme,
      intensity: scene.intensity,
      speed: scene.speed,
      audio: {
        assetId: available ? scene.audioId : null,
        gain: scene.audioGain ?? 1,
        offset: scene.audioOffset ?? 0,
      },
    };
  });
  return {
    warnings,
    manifest: {
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      createdAt: new Date().toISOString(),
      app: { name: "Resonance", version: "1.1" },
      show: {
        id: doc.showId,
        name: safeFileName(doc.showName, "Untitled session"),
        activeSceneId: doc.activeId,
      },
      performance: {
        bpm: doc.bpm,
        master: doc.master,
        gain: doc.gain,
        sensitivity: doc.sensitivity,
        smoothing: doc.smoothing,
        transition: doc.transition,
        strobe: doc.strobe,
        blackout: doc.blackout,
        frozen: doc.frozen,
      },
      scenes,
      assets: [...unique.values()],
    },
  };
}

/**
 * Reads both the current schema and the early (`version: 1`) packages that had
 * no live-control block at all. Every unknown or missing field falls back to a
 * safe default so a partial manifest never stops the file from being inspected.
 */
export function parseManifest(
  raw: unknown,
  fileName: string,
): ParsedManifest {
  const fallbackName =
    fileName.replace(/\.[^.]+$/, "").replace(/\.resonance$/i, "") ||
    "Untitled session";
  const issues: ShowIssue[] = [];
  if (!isObject(raw))
    return {
      fileName,
      showId: "recovered-show",
      showName: fallbackName,
      activeSceneId: "",
      version: 1,
      createdAt: "",
      performance: { ...defaultPerformance },
      scenes: [],
      assets: [],
      issues: [
        {
          code: "manifest-invalid",
          level: "fatal",
          message: "演出包清单无法读取，文件可能已损坏。",
        },
      ],
    };

  const format = raw.format;
  if (format !== undefined && format !== PACKAGE_FORMAT)
    issues.push({
      code: "format-unsupported",
      level: "fatal",
      message: `不支持的文件格式“${String(format)}”，这不是 Resonance 演出包。`,
    });
  else if (format === undefined)
    issues.push({
      code: "format-missing",
      level: "warning",
      message: "演出包缺少格式标记，已尝试按早期演出包读取。",
    });

  const version = number(raw.version, 1);
  if (!SUPPORTED_VERSIONS.includes(version))
    issues.push({
      code: "version-unsupported",
      level: "fatal",
      message: `演出包版本 ${String(raw.version)} 高于此应用支持的版本（${SUPPORTED_VERSIONS.join(" / ")}）。`,
    });

  const show = isObject(raw.show) ? raw.show : raw;
  const showName =
    text(show.name) ||
    text(raw.name) ||
    text(raw.title) ||
    fallbackName;
  const showId = text(show.id) || text(raw.id) || "recovered-show";
  const createdAt = text(raw.createdAt);

  const rawPerformance = [
    raw.performance,
    raw.live,
    raw.controls,
  ].find(isObject);
  const policy = rawPerformance ?? {};
  const hasPerformance = isObject(rawPerformance);
  if (!hasPerformance)
    issues.push({
      code: "performance-defaulted",
      level: "warning",
      message: "早期演出包不含现场控制设置，已使用默认值。",
    });
  const performance: PerformanceSettings = {
    bpm: clamp(
      number(policy.bpm, number(raw.bpm, defaultPerformance.bpm)),
      30,
      300,
    ),
    master: clamp(
      number(policy.master, number(raw.master, defaultPerformance.master)),
    ),
    gain: clamp(number(policy.gain, number(raw.gain, defaultPerformance.gain))),
    sensitivity: clamp(
      number(
        policy.sensitivity,
        number(raw.sensitivity, defaultPerformance.sensitivity),
      ),
      0.3,
      3,
    ),
    smoothing: clamp(
      number(
        policy.smoothing,
        number(raw.smoothing, defaultPerformance.smoothing),
      ),
      0,
      0.95,
    ),
    transition: clamp(
      number(
        policy.transition,
        number(raw.transition, defaultPerformance.transition),
      ),
      0,
      4,
    ),
    strobe: bool(policy.strobe, bool(raw.strobe, false)),
    blackout: bool(policy.blackout, bool(raw.blackout, false)),
    frozen: bool(policy.frozen, bool(raw.frozen, false)),
  };

  const rawScenes = Array.isArray(raw.scenes)
    ? raw.scenes
    : Array.isArray(show.scenes)
      ? (show.scenes as unknown[])
      : [];
  const usedIds = new Set<string>();
  const unsupportedScenes: string[] = [];
  const scenes: ParsedScene[] = rawScenes
    .filter(isObject)
    .map((item, index) => {
      const requestedKind = text(item.kind);
      const supported = SUPPORTED_KINDS.includes(requestedKind as SceneKind);
      const kind = supported ? (requestedKind as SceneKind) : "orbit";
      const name = text(item.name, `场景 ${index + 1}`);
      if (!supported) unsupportedScenes.push(name);
      const requestedTheme = text(item.theme, themes[0].id);
      const theme = themes.some((t) => t.id === requestedTheme)
        ? requestedTheme
        : themes[0].id;
      if (theme !== requestedTheme)
        issues.push({
          code: "theme-unsupported",
          level: "warning",
          message: `场景“${name}”的主题“${requestedTheme}”不可用，将使用默认主题。`,
          sceneNames: [name],
        });
      const id = uniqueId(text(item.id, `scene-${index + 1}`), usedIds);
      const audioField = item.audio;
      const audioKey =
        isObject(audioField) && typeof audioField.assetId === "string"
          ? audioField.assetId
          : typeof audioField === "string"
            ? audioField
            : typeof item.audioId === "string"
              ? item.audioId
              : typeof item.assetId === "string"
                ? item.assetId
                : null;
      const audioGain = isObject(audioField)
        ? clamp(number(audioField.gain, 1), 0, 2)
        : clamp(number(item.audioGain, 1), 0, 2);
      const audioOffset = isObject(audioField)
        ? Math.max(0, number(audioField.offset, 0))
        : Math.max(0, number(item.audioOffset, 0));
      return {
        id,
        name,
        kind,
        requestedKind,
        supported,
        theme,
        intensity: clamp(number(item.intensity, 0.8), 0.1, 1.5),
        speed: clamp(number(item.speed, 1), 0.1, 2),
        audioKey,
        audioGain,
        audioOffset,
      };
    });

  if (unsupportedScenes.length)
    issues.push({
      code: "scene-kind-unsupported",
      level: scenes.some((scene) => scene.supported) ? "warning" : "fatal",
      message: scenes.some((scene) => scene.supported)
        ? `${unsupportedScenes.length} 个场景使用了此版本不支持的效果，打开时将被跳过：${unsupportedScenes.join("、")}。`
        : `包内所有场景都使用了此版本不支持的效果：${unsupportedScenes.join("、")}。`,
      sceneNames: unsupportedScenes,
    });
  if (!scenes.some((scene) => scene.supported) && !unsupportedScenes.length)
    issues.push({
      code: "scenes-empty",
      level: "fatal",
      message: "演出包中没有可用的场景。",
    });

  const rawAssets = Array.isArray(raw.assets)
    ? raw.assets
    : Array.isArray(raw.audio)
      ? raw.audio
      : isObject(show.assets) || Array.isArray(show.assets)
        ? (show.assets as unknown[])
        : [];
  const assets: ParsedAsset[] = rawAssets
    .filter(isObject)
    .map((item, index) => {
      const hash = text(item.hash);
      const id = text(item.id, hash || `asset-${index + 1}`);
      const name = text(item.name, id);
      const mime = text(item.mime, text(item.type, "audio/*"));
      const size = Math.max(0, number(item.size, 0));
      const duration = Math.max(0, number(item.duration, 0));
      const path =
        text(item.path) ||
        text(item.file) ||
        (hash ? `audio/${hash}.${extensionFor(mime, name)}` : name);
      return { key: id, hash, name, mime, size, duration, path };
    });

  const activeSceneId =
    text(show.activeSceneId) ||
    text(show.activeId) ||
    text(raw.activeId) ||
    scenes[0]?.id ||
    "";

  return {
    fileName,
    showId,
    showName,
    activeSceneId,
    version,
    createdAt,
    performance,
    scenes,
    assets,
    issues,
  };
}
