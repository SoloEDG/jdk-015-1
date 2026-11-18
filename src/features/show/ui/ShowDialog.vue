<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileAudio,
  PackageOpen,
  ShieldCheck,
  X,
} from "lucide-vue-next";
import type { ShowStore } from "../model/showStore";
import type { MissingAsset } from "../lib/package";
import { formatBytes } from "../../../shared/hash";
import { clock } from "../../../shared/math";

const props = defineProps<{ store: ShowStore }>();

const dialog = ref<HTMLElement>();
function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  props.store.cancelOpen();
}
watch(
  () => props.store.state.inspection,
  async (value) => {
    if (value) {
      window.addEventListener("keydown", onKey);
      await nextTick();
      dialog.value?.focus({ preventScroll: true });
    } else window.removeEventListener("keydown", onKey);
  },
  { immediate: true },
);
onUnmounted(() => window.removeEventListener("keydown", onKey));

const inputs = ref<Record<string, HTMLInputElement | null>>({});
const inspection = computed(() => props.store.state.inspection);
const skippedScenes = computed(
  () => inspection.value?.parsed.scenes.filter((scene) => !scene.supported) ?? [],
);
const unresolved = computed(() => props.store.unresolvedMissing);
const fatal = computed(() => inspection.value?.fatal ?? []);
const warnings = computed(() => inspection.value?.warnings ?? []);
const skipped = computed(() => inspection.value?.missing.filter((item) => props.store.isSkipped(item)) ?? []);
const confirmProgress = computed(() => props.store.state.confirmProgress);

function pickAsset(item: MissingAsset) {
  inputs.value[item.key]?.click();
}
async function choose(e: Event, item: MissingAsset) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await props.store.replaceMissing(item, file);
}
</script>
<template>
  <div v-if="inspection" class="show-overlay" @keydown.esc="store.cancelOpen()">
    <section
      ref="dialog"
      class="show-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="show-dialog-title"
      tabindex="-1"
    >
      <header>
        <div>
          <span class="eyebrow">OPEN SHOW PACKAGE</span>
          <h2 id="show-dialog-title">{{ inspection.parsed.showName }}</h2>
          <small>
            {{ inspection.fileName }} · 版本
            {{ inspection.parsed.version }} ·
            {{ inspection.parsed.scenes.length }} 个场景 ·
            {{ inspection.usedAssetKeys.length }} 段音频
            <template v-if="inspection.totalAssetBytes">
              · {{ formatBytes(inspection.totalAssetBytes) }}
            </template>
          </small>
        </div>
        <button
          class="dialog-close"
          aria-label="取消打开"
          :disabled="store.state.confirming"
          @click="store.cancelOpen()"
        >
          <X :size="17" />
        </button>
      </header>

      <div class="dialog-body">
        <div v-if="fatal.length" class="dialog-block fatal" role="alert">
          <h4><AlertCircle :size="15" />无法打开此演出包</h4>
          <p v-for="message in fatal" :key="message">{{ message }}</p>
        </div>

        <div v-if="!fatal.length" class="dialog-block ok">
          <h4><CheckCircle2 :size="15" />演出内容</h4>
          <div class="show-facts">
            <span>场景<strong>{{ inspection.parsed.scenes.length - skippedScenes.length }}</strong></span>
            <span>音频<strong>{{ inspection.usedAssetKeys.length }}</strong></span>
            <span>主题<strong>{{ new Set(inspection.parsed.scenes.map((s) => s.theme)).size }}</strong></span>
            <span>BPM<strong>{{ inspection.parsed.performance.bpm }}</strong></span>
          </div>
          <p class="dialog-note">
            打开后会同时应用画面、音源、快捷场景与现场控制初始值；正在录制的片段仍归属于旧演出。
          </p>
        </div>

        <div v-if="skippedScenes.length" class="dialog-block warn">
          <h4><AlertTriangle :size="15" />不支持的内容（{{ skippedScenes.length }}）</h4>
          <ul>
            <li v-for="scene in skippedScenes" :key="scene.id">
              <strong>{{ scene.name }}</strong>
              <span>效果“{{ scene.requestedKind || "未知" }}”在此版本不可用，打开时会跳过此场景。</span>
            </li>
          </ul>
        </div>

        <div v-if="inspection.missing.length" class="dialog-block warn">
          <h4>
            <FileAudio :size="15" />缺失的音频（{{ unresolved.length }} 未处理）
          </h4>
          <div v-for="item in inspection.missing" :key="item.key" class="missing-row">
            <div class="missing-info">
              <strong>{{ item.name }}</strong>
              <span>{{ item.referencedBy.join("、") }}</span>
              <small v-if="store.replacementOf(item)" class="replaced">
                已替换为 {{ store.replacementOf(item)!.file.name }} ·
                {{ clock(store.replacementOf(item)!.duration) }}
              </small>
              <small v-else-if="store.isSkipped(item)" class="skipped">
                将跳过，对应场景使用演示音轨
              </small>
              <small v-else-if="store.errorOf(item)" role="alert">{{ store.errorOf(item) }}</small>
              <small v-else>包内缺少此音频，可替换或跳过</small>
            </div>
            <div class="missing-actions">
              <button
                :disabled="store.state.confirming"
                @click="pickAsset(item)"
              >
                {{ store.replacementOf(item) ? "重新选择" : "替换音频" }}
              </button>
              <button
                v-if="store.replacementOf(item)"
                :disabled="store.state.confirming"
                @click="store.clearReplacement(item)"
              >
                清除
              </button>
              <button
                v-else
                :class="{ selected: store.isSkipped(item) }"
                :disabled="store.state.confirming"
                @click="store.toggleSkip(item)"
              >
                {{ store.isSkipped(item) ? "恢复" : "跳过" }}
              </button>
              <input
                :ref="(el) => (inputs[item.key] = el as HTMLInputElement | null)"
                type="file"
                accept="audio/*"
                @change="choose($event, item)"
              />
            </div>
          </div>
        </div>

        <div v-if="warnings.length" class="dialog-block note-block">
          <h4><AlertTriangle :size="15" />需要注意</h4>
          <ul>
            <li v-for="message in warnings" :key="message">{{ message }}</li>
          </ul>
        </div>

        <div v-if="skipped.length" class="dialog-block note-block">
          <h4><ShieldCheck :size="15" />将跳过 {{ skipped.length }} 段音频</h4>
          <p>{{ skipped.map((item) => item.name).join("、") }}</p>
        </div>

        <div v-if="store.state.confirmError" class="dialog-block fatal" role="alert">
          <h4><AlertCircle :size="15" />打开失败</h4>
          <p>{{ store.state.confirmError }}</p>
          <p class="dialog-note">旧演出、音源与已录制片段均保持不变。</p>
        </div>

        <div v-if="confirmProgress" class="dialog-progress">
          <span>{{ confirmProgress.phase }}</span>
          <i><b :style="{ width: `${Math.round(confirmProgress.ratio * 100)}%` }"></b></i>
          <em>{{ Math.round(confirmProgress.ratio * 100) }}%</em>
        </div>
      </div>

      <footer class="dialog-footer">
        <span class="dialog-note">
          <PackageOpen :size="13" />
          <template v-if="fatal.length">文件无法使用</template>
          <template v-else-if="unresolved.length">
            还有 {{ unresolved.length }} 段缺失音频待替换或跳过
          </template>
          <template v-else>校验通过，可整体打开</template>
        </span>
        <div>
          <button :disabled="store.state.confirming" @click="store.cancelOpen()">
            取消
          </button>
          <button
            class="primary"
            :disabled="!store.canConfirm"
            @click="store.confirmOpen()"
          >
            {{ store.state.confirming ? "正在打开…" : "打开演出" }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
