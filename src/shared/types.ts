export type SceneKind = "orbit" | "spectrum" | "wave" | "tunnel";
export interface Scene {
  id: string;
  name: string;
  kind: SceneKind;
  theme: string;
  intensity: number;
  speed: number;
  /** Content-addressed audio asset used by this scene. */
  audioId: string | null;
  /** Scene-local audio trim, so scenes can share one asset independently. */
  audioGain: number;
  audioOffset: number;
}
export interface Analysis {
  bins: number[];
  wave: number[];
  rms: number;
  bass: number;
  beat: boolean;
  time: number;
}
export interface StageDocument {
  showId: string;
  showName: string;
  scenes: Scene[];
  activeId: string;
  gain: number;
  sensitivity: number;
  smoothing: number;
  transition: number;
  blackout: boolean;
  frozen: boolean;
  strobe: boolean;
  master: number;
  bpm: number;
}
export interface AudioAsset {
  /** Stable content hash, also used as the package file name. */
  id: string;
  hash: string;
  name: string;
  mime: string;
  size: number;
  duration: number;
  blob: Blob;
  url: string;
  origin: "local" | "package";
}
export interface Take {
  id: string;
  url: string;
  size: number;
  duration: number;
  name: string;
  mime: string;
  showId: string;
  showName: string;
}
export interface Theme {
  id: string;
  name: string;
  colors: [string, string, string];
  background: string;
}
