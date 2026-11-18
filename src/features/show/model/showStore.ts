import { computed, reactive, ref, shallowRef } from "vue";
import type { StageDocument } from "../../../shared/types";
import { downloadBlob } from "../../../shared/math";
import { sha256 } from "../../../shared/hash";
import type { AudioEngine } from "../../audio/model/engine";
import {
  buildImportedShow,
  exportPackage,
  inspectPackage,
  type ExportProgress,
  type Inspection,
  type MissingAsset,
  type ReadProgress,
  type Replacement,
} from "../lib/package";

export interface ShowDependencies {
  doc: StageDocument;
  audio: AudioEngine;
}

export function createShowStore({ doc, audio }: ShowDependencies) {
  const saving = ref(false),
    progress = shallowRef<ExportProgress | null>(null),
    message = ref(""),
    error = ref(""),
    opening = ref(false),
    openProgress = shallowRef<ReadProgress | null>(null),
    inspection = shallowRef<Inspection | null>(null),
    dialogOpen = ref(false),
    skipped = ref<string[]>([]),
    replacements = shallowRef<Record<string, Replacement>>({}),
    replacementErrors = reactive<Record<string, string>>({}),
    confirming = ref(false),
    confirmError = ref(""),
    confirmProgress = shallowRef<ReadProgress | null>(null),
    skippedNotice = ref("");
  let token = 0;

  const state = reactive({
    saving,
    progress,
    message,
    error,
    opening,
    openProgress,
    inspection,
    dialogOpen,
    skipped,
    replacements,
    replacementErrors,
    confirming,
    confirmError,
    confirmProgress,
    skippedNotice,
  });

  function clearMessages() {
    message.value = "";
    error.value = "";
    skippedNotice.value = "";
  }

  async function save() {
    if (saving.value) return;
    clearMessages();
    saving.value = true;
    progress.value = { phase: "准备素材", completed: 0, total: 0, ratio: 0 };
    try {
      const result = await exportPackage(doc, audio.assetsInUse(), (next) => {
        progress.value = next;
      });
      downloadBlob(result.blob, result.fileName);
      message.value = result.warnings.length
        ? `演出包已生成。${result.warnings.join(" ")}`
        : "演出包已生成，可在另一台电脑完整打开。";
    } catch (e) {
      error.value = e instanceof Error ? e.message : "打包失败，请重试。";
    } finally {
      saving.value = false;
      progress.value = null;
    }
  }

  function closeDialog() {
    if (confirming.value) return;
    dialogOpen.value = false;
    inspection.value = null;
    skipped.value = [];
    replacements.value = {};
    Object.keys(replacementErrors).forEach((key) => delete replacementErrors[key]);
    confirmError.value = "";
    openProgress.value = null;
    confirmProgress.value = null;
  }

  async function openFile(file: File) {
    clearMessages();
    const ticket = ++token;
    opening.value = true;
    openProgress.value = {
      phase: "读取压缩包目录",
      completed: 0,
      total: file.size,
      ratio: 0,
    };
    try {
      const result = await inspectPackage(file, ticket, (next) => {
        if (ticket === token) openProgress.value = next;
      });
      if (ticket !== token) return;
      inspection.value = result;
      skipped.value = [];
      replacements.value = {};
      Object.keys(replacementErrors).forEach(
        (key) => delete replacementErrors[key],
      );
      confirmError.value = "";
      dialogOpen.value = true;
    } catch (e) {
      if (ticket !== token) return;
      // Inspection is read-only: a broken package never touches the old show,
      // its audio or its recordings.
      error.value = e instanceof Error ? e.message : "无法读取演出包。";
    } finally {
      if (ticket === token) {
        opening.value = false;
        openProgress.value = null;
      }
    }
  }

  function cancelOpen() {
    closeDialog();
  }

  async function replaceMissing(item: MissingAsset, file: File) {
    if (confirming.value) return;
    delete replacementErrors[item.key];
    try {
      const blob = file.slice(0, file.size, file.type || "audio/*");
      const [buffer, hash] = await Promise.all([
        audio.decode(blob),
        sha256(blob),
      ]);
      replacements.value = {
        ...replacements.value,
        [item.key]: { file, blob, hash, duration: buffer.duration, buffer },
      };
      skipped.value = skipped.value.filter((key) => key !== item.key);
      confirmError.value = "";
    } catch {
      replacementErrors[item.key] = "无法解码此音频，请选择有效的音频文件。";
      clearReplacement(item);
    }
  }

  function clearReplacement(item: MissingAsset) {
    const next = { ...replacements.value };
    delete next[item.key];
    replacements.value = next;
  }

  function toggleSkip(item: MissingAsset) {
    if (skipped.value.includes(item.key))
      skipped.value = skipped.value.filter((key) => key !== item.key);
    else {
      skipped.value = [...skipped.value, item.key];
      clearReplacement(item);
      delete replacementErrors[item.key];
    }
  }

  function isSkipped(item: MissingAsset) {
    return skipped.value.includes(item.key);
  }

  function replacementOf(item: MissingAsset): Replacement | undefined {
    return replacements.value[item.key];
  }

  function errorOf(item: MissingAsset) {
    return replacementErrors[item.key] ?? "";
  }

  const unresolvedMissing = computed(() => {
    const current = inspection.value;
    if (!current) return [] as MissingAsset[];
    return current.missing.filter(
      (item) =>
        !replacements.value[item.key] && !skipped.value.includes(item.key),
    );
  });

  const canConfirm = computed(() => {
    const current = inspection.value;
    if (!current || confirming.value || current.fatal.length) return false;
    return unresolvedMissing.value.length === 0;
  });

  /** One synchronous turn so visuals, audio, cues and recording agree. */
  function applyDocument(next: StageDocument) {
    doc.showId = next.showId;
    doc.showName = next.showName;
    doc.scenes = next.scenes;
    doc.activeId = next.activeId;
    doc.gain = next.gain;
    doc.sensitivity = next.sensitivity;
    doc.smoothing = next.smoothing;
    doc.transition = next.transition;
    doc.blackout = next.blackout;
    doc.frozen = next.frozen;
    doc.strobe = next.strobe;
    doc.master = next.master;
    doc.bpm = next.bpm;
  }

  async function confirmOpen() {
    const current = inspection.value;
    if (!current || !canConfirm.value) return;
    confirming.value = true;
    confirmError.value = "";
    confirmProgress.value = { phase: "校验素材", completed: 0, total: 0, ratio: 0 };
    try {
      const imported = await buildImportedShow(
        current,
        audio,
        skipped.value,
        replacements.value,
        (next) => {
          confirmProgress.value = next;
        },
      );
      const skippedNames = current.missing
        .filter((item) => skipped.value.includes(item.key))
        .map((item) => item.name);
      // Everything below runs in the same task: the stage, the sound source,
      // the quick cues, the next recording target switch together, so no frame
      // mixes the old and new show.
      applyDocument(imported.document);
      audio.adoptShow(imported.assets);
      skippedNotice.value = skippedNames.length
        ? `已跳过缺失音频：${skippedNames.join("、")}，对应场景使用演示音轨。`
        : "";
      message.value = `已打开演出“${imported.showName}”。`;
      dialogOpen.value = false;
      inspection.value = null;
      skipped.value = [];
      replacements.value = {};
      Object.keys(replacementErrors).forEach(
        (key) => delete replacementErrors[key],
      );
      confirmProgress.value = null;
    } catch (e) {
      // Validation failed: old show, audio and recordings stay as they were.
      confirmError.value =
        e instanceof Error ? e.message : "打开失败，旧演出与录制已保留。";
    } finally {
      confirming.value = false;
    }
  }

  // Reactive proxy so `store.canConfirm` / `store.unresolvedMissing` unwrap
  // their computed refs for templates and callers.
  return reactive({
    state,
    save,
    openFile,
    cancelOpen,
    replaceMissing,
    clearReplacement,
    toggleSkip,
    isSkipped,
    replacementOf,
    errorOf,
    unresolvedMissing,
    canConfirm,
    confirmOpen,
  });
}
export type ShowStore = ReturnType<typeof createShowStore>;
