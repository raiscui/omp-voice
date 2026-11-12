import { expect, test } from "bun:test";
import { play } from "./read-aloud.ts";

// 模拟宿主 managed-timers 的簿记语义: setInterval 登记, 只有 clearTimer 会注销。
// 回归点: play() 结束后受管登记数必须归零——全局 clearInterval 不清簿记, 会按播放次数泄漏受管句柄。
// 真实时钟说明: 这是集成测试, 进度定时器由真实 afplay 子进程的 spawn/exit 事件驱动,
// fake timers 无法推进外部进程的生命周期, 只能等真实播放结束(200ms 样本, 总耗时可忽略)。
// stub 里的 setInterval 不是测试等待, 是被测簿记语义本身。
test("play() 受管进度定时器在每轮播放结束后全部注销", async () => {
  const live = new Set<Timer>();
  const timers = {
    setInterval: (callback: () => void, ms?: number) => {
      const timer = setInterval(callback, ms);
      live.add(timer);
      return timer;
    },
    clearTimer: (timer: Timer) => {
      clearInterval(timer);
      live.delete(timer);
    },
  };
  const wav = makeTinyWav(200);
  for (let cycle = 1; cycle <= 3; cycle++) {
    const job = { abort: new AbortController() } as unknown as Parameters<typeof play>[1];
    let ticks = 0;
    await play(
      wav,
      job,
      () => {},
      { offsetMs: 0, durationMs: 200, onProgress: () => { ticks++; } } as unknown as Parameters<typeof play>[3],
      timers,
    );
    expect(ticks).toBeGreaterThan(0); // onStarted 里至少回调一次初始进度
    expect(live.size).toBe(0); // 本轮受管句柄已全部注销, 不残留到下一轮
  }
}, 15_000); // 3 轮真实 afplay 播放, 每轮约 1.1s, 放宽默认 5s 限时

function makeTinyWav(ms: number): Uint8Array {
  const sampleRate = 8000;
  const samples = Math.floor((sampleRate * ms) / 1000);
  const dataSize = samples * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), true);
  }
  return new Uint8Array(view.buffer);
}
