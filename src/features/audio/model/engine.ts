import { reactive, shallowRef } from "vue";
import type {
  Analysis,
  AudioAsset,
  Scene,
  StageDocument,
} from "../../../shared/types";
import { analyse } from "../lib/analyse";
import { demoBuffer } from "../lib/demo";
import { extensionFor, sha256 } from "../../../shared/hash";

export type AudioSource = "demo" | "file" | "mic";
export interface AdoptedAsset {
  asset: AudioAsset;
  buffer: AudioBuffer;
}

const DEMO_NAME = "Midnight / 120 BPM";
const DEMO_DURATION = 16;

export function createAudio(doc: StageDocument) {
  const state = reactive({
    playing: false,
    source: "demo" as AudioSource,
    name: DEMO_NAME,
    duration: DEMO_DURATION,
    position: 0,
    error: "",
    loading: false,
    sceneId: "",
    assetId: null as string | null,
  });
  const frame = shallowRef<Analysis>({
    bins: Array(128).fill(0),
    wave: Array(256).fill(0),
    rms: 0,
    bass: 0,
    beat: false,
    time: 0,
  });
  let ctx: AudioContext,
    analyser: AnalyserNode,
    gain: GainNode,
    destination: MediaStreamAudioDestinationNode;
  let buffer: AudioBuffer,
    node: AudioBufferSourceNode | MediaStreamAudioSourceNode | undefined,
    mic: MediaStream | undefined;
  let origin = 0,
    offset = 0,
    epoch = 0,
    raf = 0;
  const assets = new Map<string, AudioAsset>(),
    buffers = new Map<string, AudioBuffer>();

  function activeScene(): Scene | undefined {
    return doc.scenes.find((s) => s.id === doc.activeId) ?? doc.scenes[0];
  }
  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    gain = ctx.createGain();
    destination = ctx.createMediaStreamDestination();
    analyser.connect(gain);
    gain.connect(ctx.destination);
    analyser.connect(destination);
    buffer = demoBuffer(ctx);
  }
  function detach() {
    if (node) {
      if (node instanceof AudioBufferSourceNode) {
        node.onended = null;
        try {
          node.stop();
        } catch {}
      }
      node.disconnect();
      node = undefined;
    }
    mic?.getTracks().forEach((t) => t.stop());
    mic = undefined;
  }
  function pump() {
    if (!ctx) return;
    const f = new Uint8Array(analyser.frequencyBinCount),
      w = new Uint8Array(analyser.fftSize);
    analyser.smoothingTimeConstant = doc.smoothing;
    gain.gain.value =
      state.source === "mic"
        ? 0
        : doc.gain *
          (doc.scenes.find((s) => s.id === doc.activeId)?.audioGain ?? 1);
    analyser.getByteFrequencyData(f);
    analyser.getByteTimeDomainData(w);
    state.position = state.playing ? offset + ctx.currentTime - origin : offset;
    frame.value = analyse(
      f,
      w,
      state.position,
      doc.sensitivity,
      frame.value.bass,
    );
    raf = requestAnimationFrame(pump);
  }
  function beginPlayback() {
    if (!state.playing || !ctx) return;
    if (state.source === "mic") {
      void microphone();
      return;
    }
    const target = state.assetId ? buffers.get(state.assetId) : undefined;
    const sourceBuffer = target ?? buffer;
    if (!sourceBuffer) return;
    node = ctx.createBufferSource();
    node.buffer = sourceBuffer;
    node.loop = true;
    node.connect(analyser);
    origin = ctx.currentTime;
    node.start(0, Math.min(offset % sourceBuffer.duration, sourceBuffer.duration));
    if (!raf) pump();
  }
  async function play() {
    init();
    await ctx.resume();
    if (state.playing) return;
    if (state.source === "mic") {
      await microphone();
      return;
    }
    state.playing = true;
    beginPlayback();
  }
  function pause() {
    if (!state.playing) return;
    offset = state.position;
    detach();
    state.playing = false;
  }
  /** Point the engine at the sound and parameters of the given scene. */
  function followScene(scene: Scene | undefined, force = false) {
    if (!scene) return;
    if (state.source === "mic" && !force) {
      state.sceneId = scene.id;
      return;
    }
    const nextId = scene.audioId;
    const nextBuffer = nextId ? buffers.get(nextId) : undefined;
    // Scenes without their own asset share the demo track; switching between
    // them must not restart the sound.
    if (!nextId && !force && state.source === "demo") {
      state.sceneId = scene.id;
      return;
    }
    const sameSource =
      state.sceneId === scene.id &&
      state.assetId === (nextBuffer ? nextId : null) &&
      (nextBuffer ? state.source === "file" : state.source === "demo");
    if (sameSource && !force) return;
    const wasPlaying = state.playing;
    detach();
    state.playing = false;
    state.sceneId = scene.id;
    state.assetId = nextBuffer ? nextId : null;
    state.source = nextBuffer ? "file" : "demo";
    state.duration = nextBuffer?.duration ?? DEMO_DURATION;
    state.name = nextBuffer
      ? (assets.get(nextId!)?.name ?? "场景音频")
      : DEMO_NAME;
    offset = nextBuffer
      ? Math.max(0, Math.min(scene.audioOffset || 0, state.duration - 0.05))
      : 0;
    state.position = offset;
    state.error = "";
    if (nextId && !nextBuffer)
      state.error = "此场景的音频素材不可用，已回退到演示音轨。";
    if (wasPlaying) {
      state.playing = true;
      beginPlayback();
    }
  }
  async function decode(blob: Blob): Promise<AudioBuffer> {
    init();
    const bytes = await blob.arrayBuffer();
    return ctx.decodeAudioData(bytes);
  }
  function revokeAll() {
    assets.forEach((a) => URL.revokeObjectURL(a.url));
    assets.clear();
    buffers.clear();
  }
  async function file(file: File) {
    init();
    const ticket = ++epoch;
    state.loading = true;
    state.error = "";
    try {
      const blob = file.slice(0, file.size, file.type || "audio/*");
      const [next, hash] = await Promise.all([decode(blob), sha256(blob)]);
      if (ticket !== epoch) return;
      let asset = assets.get(hash);
      if (!asset) {
        asset = {
          id: hash,
          hash,
          name: file.name || `audio.${extensionFor(file.type)}`,
          mime: file.type || "audio/*",
          size: blob.size,
          duration: next.duration,
          blob,
          url: URL.createObjectURL(blob),
          origin: "local",
        };
        assets.set(hash, asset);
      }
      buffers.set(asset.id, next);
      const scene = activeScene();
      if (scene) {
        scene.audioId = asset.id;
        scene.audioOffset = 0;
      }
      state.playing = false;
      followScene(scene, true);
      state.playing = true;
      await ctx.resume();
      beginPlayback();
    } catch {
      if (ticket === epoch)
        state.error = "无法解码此音频，请选择有效的音频文件。原有音源已保留。";
    } finally {
      if (ticket === epoch) state.loading = false;
    }
  }
  async function microphone() {
    init();
    const ticket = ++epoch;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (ticket !== epoch) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      detach();
      mic = stream;
      node = ctx.createMediaStreamSource(stream);
      node.connect(analyser);
      state.source = "mic";
      state.name = "Live microphone";
      state.playing = true;
      offset = 0;
      origin = ctx.currentTime;
      await ctx.resume();
      if (!raf) pump();
    } catch {
      state.error = "麦克风不可用或未获授权，原有音源已保留。";
    }
  }
  async function demo() {
    init();
    ++epoch;
    const scene = activeScene();
    if (scene) {
      scene.audioId = null;
      scene.audioOffset = 0;
    }
    detach();
    state.playing = false;
    state.source = "demo";
    state.name = DEMO_NAME;
    state.assetId = null;
    state.sceneId = scene?.id ?? "";
    offset = 0;
    state.duration = DEMO_DURATION;
    await ctx.resume();
    await play();
  }
  /** Restart the current scene's track from its own trim offset. */
  function restartScene() {
    followScene(activeScene(), true);
  }
  function getAsset(id: string | null) {
    return id ? assets.get(id) : undefined;
  }
  function assetsInUse() {
    const used = new Map<string, AudioAsset>();
    doc.scenes.forEach((s) => {
      const a = getAsset(s.audioId);
      if (a) used.set(a.hash, a);
    });
    return [...used.values()];
  }
  /** Swap the whole sound registry for an imported show. */
  function adoptShow(entries: AdoptedAsset[]) {
    ++epoch;
    const wasPlaying = state.playing;
    detach();
    state.playing = false;
    revokeAll();
    entries.forEach(({ asset, buffer: decoded }) => {
      assets.set(asset.id, asset);
      buffers.set(asset.id, decoded);
    });
    if (!ctx) init();
    state.sceneId = "";
    followScene(activeScene(), true);
    if (wasPlaying) {
      state.playing = true;
      void ctx.resume().then(beginPlayback);
    }
  }
  function dispose() {
    ++epoch;
    cancelAnimationFrame(raf);
    detach();
    revokeAll();
    void ctx?.close();
  }
  followScene(activeScene());
  return {
    state,
    frame,
    play,
    pause,
    file,
    microphone,
    demo,
    decode,
    followScene,
    restartScene,
    adoptShow,
    getAsset,
    assetsInUse,
    dispose,
    stream: () => {
      init();
      return destination.stream;
    },
  };
}
export type AudioEngine = ReturnType<typeof createAudio>;
