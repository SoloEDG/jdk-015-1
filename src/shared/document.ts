import { reactive } from "vue";
import type { StageDocument } from "./types";

export function uid(prefix = "id"): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDocument(): StageDocument {
  return reactive({
    showId: uid("show"),
    showName: "Untitled session",
    scenes: [
      {
        id: "s1",
        name: "Celestial orbit",
        kind: "orbit",
        theme: "violet",
        intensity: 0.8,
        speed: 1,
        audioId: null,
        audioGain: 1,
        audioOffset: 0,
      },
      {
        id: "s2",
        name: "Frequency field",
        kind: "spectrum",
        theme: "mint",
        intensity: 0.75,
        speed: 1,
        audioId: null,
        audioGain: 1,
        audioOffset: 0,
      },
      {
        id: "s3",
        name: "Liquid signal",
        kind: "wave",
        theme: "ember",
        intensity: 0.7,
        speed: 0.6,
        audioId: null,
        audioGain: 1,
        audioOffset: 0,
      },
      {
        id: "s4",
        name: "Into the void",
        kind: "tunnel",
        theme: "ice",
        intensity: 0.9,
        speed: 1.2,
        audioId: null,
        audioGain: 1,
        audioOffset: 0,
      },
    ],
    activeId: "s1",
    gain: 0.65,
    sensitivity: 1.2,
    smoothing: 0.78,
    transition: 1.2,
    blackout: false,
    frozen: false,
    strobe: false,
    master: 1,
    bpm: 120,
  });
}
