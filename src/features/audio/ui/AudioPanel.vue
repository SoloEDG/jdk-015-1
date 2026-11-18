<script setup lang="ts">
import type { AudioEngine } from "../model/engine";
import type { StageDocument } from "../../../shared/types";
import { clock } from "../../../shared/math";
import { formatBytes } from "../../../shared/hash";
defineProps<{ engine: AudioEngine; doc: StageDocument }>();
function load(e: Event, engine: AudioEngine) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (f) void engine.file(f);
}
</script>
<template>
  <section class="panel audio-panel">
    <div class="panel-heading">
      <span>01 / AUDIO INPUT</span
      ><span class="dot" :class="{ on: engine.state.playing }"></span>
    </div>
    <h3>声音，从这里开始</h3>
    <div class="source-tabs">
      <button
        :class="{ selected: engine.state.source === 'demo' }"
        @click="engine.demo"
      >
        演示音轨</button
      ><label class="file-button"
        >场景音频<input
          type="file"
          accept="audio/*"
          @change="load($event, engine)" /></label
      ><button
        :class="{ selected: engine.state.source === 'mic' }"
        @click="engine.microphone"
      >
        麦克风
      </button>
    </div>
    <div class="track">
      <div class="album">♫</div>
      <div>
        <strong>{{ engine.state.name }}</strong
        ><small>{{
          engine.state.source === "mic"
            ? "实时输入 · 不监听回放"
            : engine.state.assetId
              ? `SCENE AUDIO · ${formatBytes(engine.getAsset(engine.state.assetId)?.size ?? 0)}`
              : "STEREO · LOOP ENABLED"
        }}</small>
      </div>
    </div>
    <div class="transport">
      <button
        class="play"
        @click="engine.state.playing ? engine.pause() : engine.play()"
      >
        {{ engine.state.playing ? "Ⅱ" : "▶" }}</button
      ><span
        >{{ clock(engine.state.position) }}
        <i
          >/
          {{
            engine.state.source === "mic"
              ? "LIVE"
              : clock(engine.state.duration)
          }}</i
        ></span
      ><span class="tag">{{ engine.state.loading ? "解码中" : "AUDIO" }}</span>
    </div>
    <label class="control"
      >监听音量 <b>{{ Math.round(doc.gain * 100) }}%</b
      ><input
        type="range"
        min="0"
        max="1"
        step="0.01"
        v-model.number="doc.gain" /></label
    ><label class="control"
      >响应灵敏度 <b>{{ doc.sensitivity.toFixed(1) }}×</b
      ><input
        type="range"
        min="0.3"
        max="3"
        step="0.1"
        v-model.number="doc.sensitivity"
    /></label>
    <template v-if="engine.state.source !== 'mic'">
      <label class="control scene-audio-control"
        >本场景音频音量
        <b
          >{{
            Math.round(
              (doc.scenes.find((s) => s.id === doc.activeId)?.audioGain ?? 1) *
                100,
            )
          }}%</b
        ><input
          type="range"
          min="0"
          max="2"
          step="0.01"
          :value="doc.scenes.find((s) => s.id === doc.activeId)?.audioGain ?? 1"
          @input="
            (e) => {
              const scene = doc.scenes.find((s) => s.id === doc.activeId);
              if (scene) scene.audioGain = (e.target as HTMLInputElement).valueAsNumber;
            }
          "
      /></label>
      <label class="control"
        >本场景起点
        <b
          >{{
            clock(doc.scenes.find((s) => s.id === doc.activeId)?.audioOffset ?? 0)
          }}</b
        ><input
          type="range"
          min="0"
          :max="Math.max(0, engine.state.duration - 0.1)"
          step="0.1"
          :value="
            Math.min(
              doc.scenes.find((s) => s.id === doc.activeId)?.audioOffset ?? 0,
              Math.max(0, engine.state.duration - 0.1),
            )
          "
          @input="
            (e) => {
              const scene = doc.scenes.find((s) => s.id === doc.activeId);
              if (scene)
                scene.audioOffset = (e.target as HTMLInputElement).valueAsNumber;
            }
          "
          @change="engine.restartScene"
      /></label>
    </template>
    <p v-if="engine.state.error" role="alert">{{ engine.state.error }}</p>
    <div class="input-level">
      <span
        v-for="i in 28"
        :key="i"
        :class="{ lit: engine.frame.value.rms * 100 > i }"
      ></span>
    </div>
    <small class="muted"
      >INPUT LEVEL
      <em>{{ (engine.frame.value.rms * 100).toFixed(1) }} dBFS ref</em></small
    >
  </section>
</template>
