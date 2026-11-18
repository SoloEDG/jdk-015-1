import { reactive } from "vue";
import type { StageDocument, Take } from "../../../shared/types";
import { recordingMime, takeName } from "../lib/format";

export function createRecorder(doc: StageDocument) {
  const state = reactive({
    status: "idle",
    error: "",
    elapsed: 0,
    takes: [] as Take[],
  });
  let recorder: MediaRecorder | undefined,
    chunks: Blob[] = [],
    started = 0,
    timer = 0,
    video: MediaStream | undefined,
    activeShow: { id: string; name: string } | undefined;

  function start(canvas: HTMLCanvasElement, audio: MediaStream) {
    if (state.status !== "idle") return;
    state.error = "";
    activeShow = { id: doc.showId, name: doc.showName };
    try {
      if (!window.MediaRecorder || !canvas.captureStream)
        throw Error("此浏览器不支持舞台录制");
      video = canvas.captureStream(30);
      const stream = new MediaStream([
        ...video.getVideoTracks(),
        ...audio.getAudioTracks(),
      ]);
      const mime = recordingMime();
      recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || mime });
        // The take always belongs to the show that was live when it started,
        // even if a different show is confirmed before the encoder finishes.
        state.takes.unshift({
          id: crypto.randomUUID(),
          url: URL.createObjectURL(blob),
          size: blob.size,
          duration: state.elapsed,
          name: takeName(blob.type),
          mime: blob.type,
          showId: activeShow?.id ?? doc.showId,
          showName: activeShow?.name ?? doc.showName,
        });
        video?.getTracks().forEach((t) => t.stop());
        video = undefined;
        activeShow = undefined;
        state.status = "idle";
      };
      recorder.onerror = () => {
        state.error = "录制失败，请重新开始";
        stop();
      };
      recorder.start(1000);
      started = performance.now();
      state.elapsed = 0;
      state.status = "recording";
      timer = window.setInterval(() => {
        state.elapsed = (performance.now() - started) / 1000;
      }, 100);
    } catch (e) {
      video?.getTracks().forEach((t) => t.stop());
      video = undefined;
      activeShow = undefined;
      state.error = e instanceof Error ? e.message : "无法开始录制";
      state.status = "idle";
    }
  }
  function stop() {
    if (recorder?.state === "recording") {
      state.status = "saving";
      clearInterval(timer);
      recorder.stop();
    }
  }
  function remove(id: string) {
    const i = state.takes.findIndex((t) => t.id === id);
    if (i >= 0) {
      URL.revokeObjectURL(state.takes[i].url);
      state.takes.splice(i, 1);
    }
  }
  function dispose() {
    stop();
    state.takes.forEach((t) => URL.revokeObjectURL(t.url));
  }
  return {
    state,
    start,
    stop,
    remove,
    dispose,
    activeShow: () => activeShow,
  };
}
export type StageRecorder = ReturnType<typeof createRecorder>;
