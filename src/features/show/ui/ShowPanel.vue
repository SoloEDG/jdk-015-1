<script setup lang="ts">
import { computed, ref } from "vue";
import { Disc3, FolderOpen, Save, AlertCircle, CheckCircle2 } from "lucide-vue-next";
import type { StageDocument } from "../../../shared/types";
import type { AudioEngine } from "../../audio/model/engine";
import type { ShowStore } from "../model/showStore";
import { formatBytes } from "../../../shared/hash";

const props = defineProps<{
  doc: StageDocument;
  audio: AudioEngine;
  store: ShowStore;
}>();

const picker = ref<HTMLInputElement>();
const assets = computed(() => props.audio.assetsInUse());
const assetBytes = computed(() =>
  assets.value.reduce((sum, asset) => sum + asset.size, 0),
);
const busy = computed(() => props.store.state.saving || props.store.state.opening);
const progress = computed(
  () => props.store.state.progress ?? props.store.state.openProgress,
);

function choose(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void props.store.openFile(file);
}
</script>
<template>
  <section class="show-bar" aria-label="演出包">
    <div class="show-identity">
      <Disc3 :size="22" />
      <label>
        <input
          v-model="doc.showName"
          aria-label="演出名称"
          maxlength="80"
          spellcheck="false"
        />
        <small>
          {{ doc.scenes.length }} SCENES ·
          {{ assets.length }} AUDIO {{ assetBytes ? `· ${formatBytes(assetBytes)}` : "" }}
          · LOCAL SESSION
        </small>
      </label>
    </div>
    <div class="show-status">
      <span v-if="progress" class="show-progress">
        <i>
          <b :style="{ width: `${Math.round(progress.ratio * 100)}%` }"></b>
        </i>
        {{ progress.phase }} · {{ Math.round(progress.ratio * 100) }}%
      </span>
      <span v-else-if="store.state.error" class="show-hint bad" role="alert">
        <AlertCircle :size="13" />{{ store.state.error }}
      </span>
      <span v-else-if="store.state.message" class="show-hint good">
        <CheckCircle2 :size="13" />{{ store.state.message }}
      </span>
      <span v-else class="show-hint">
        演出包会带上本地音频、场景与现场设置
      </span>
    </div>
    <div class="show-actions">
      <button :disabled="busy" @click="picker?.click()">
        <FolderOpen :size="14" />{{ store.state.opening ? "正在读取…" : "打开演出包" }}
      </button>
      <button class="primary" :disabled="busy" @click="store.save">
        <Save :size="14" />{{ store.state.saving ? "正在打包…" : "保存演出包" }}
      </button>
      <input
        ref="picker"
        type="file"
        accept=".zip,.show,.resonance,application/zip,application/x-zip-compressed"
        @change="choose"
      />
    </div>
  </section>
  <p v-if="store.state.skippedNotice" class="show-notice" role="status">
    {{ store.state.skippedNotice }}
  </p>
</template>
