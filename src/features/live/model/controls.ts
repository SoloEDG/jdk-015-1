import { computed, ref, watch } from "vue";
import type { StageDocument } from "../../../shared/types";
export function createControls(doc: StageDocument) {
  const taps = ref<number[]>([]);
  const bpm = computed({
    get: () => doc.bpm,
    set: (value: number) => {
      doc.bpm = Math.round(Math.min(300, Math.max(30, value)));
    },
  });
  watch(
    () => doc.bpm,
    (value) => {
      if (!Number.isFinite(value)) bpm.value = 120;
    },
  );
  function tap() {
    const now = performance.now();
    taps.value = [...taps.value.filter((t) => now - t < 3000), now].slice(-6);
    if (taps.value.length > 1)
      bpm.value = (60000 * (taps.value.length - 1)) / (now - taps.value[0]);
  }
  function blackout() {
    doc.blackout = !doc.blackout;
  }
  function freeze() {
    doc.frozen = !doc.frozen;
  }
  return { bpm, tap, blackout, freeze };
}
export type LiveControls = ReturnType<typeof createControls>;
