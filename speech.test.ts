import { afterEach, expect, jest, test } from "bun:test";
import { speakText, splitText, wavDurationMs } from "./speech";

const longText = "中".repeat(1500);

function audio(index: number, seconds = 20): Uint8Array {
  const wav = Buffer.alloc(44 + seconds * 2000);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(1000, 24); wav.writeUInt32LE(2000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40); wav[44] = index;
  return wav;
}

function cancelledAudio(signal: AbortSignal): Promise<Uint8Array> {
  const cancelled = Promise.withResolvers<Uint8Array>();
  signal.addEventListener("abort", () => cancelled.reject(signal.reason), { once: true });
  return cancelled.promise;
}

afterEach(() => { jest.useRealTimers(); });

test("短首段和后续段均有界, 保留 Unicode 和所有原始文本", () => {
  for (const text of ["", " \n ", "你", "😀".repeat(500), "甲".repeat(59) + "。" + "乙".repeat(700), "甲".repeat(60) + " ".repeat(400) + "乙"]) {
    const parts = splitText(text);
    if (!text.trim()) { expect(parts).toEqual([]); continue; }
    expect(parts.join("")).toBe(text);
    expect([...parts[0]].length).toBeLessThanOrEqual(60);
    for (const part of parts.slice(1)) expect([...part].length).toBeLessThanOrEqual(180);
  }
});

test("WAV 时长来自数据长度和字节速率, 支持偏移视图与附加块", () => {
  const wav = audio(0, 12);
  expect(wavDurationMs(wav)).toBe(12000);
  const padded = Buffer.concat([Buffer.of(1, 2, 3), wav]);
  expect(wavDurationMs(padded.subarray(3))).toBe(12000);
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 99, 0]);
  const extra = Buffer.concat([wav.subarray(0, 12), junk, wav.subarray(12)]);
  extra.writeUInt32LE(extra.length - 8, 4);
  expect(wavDurationMs(extra)).toBe(12000);
  expect(() => wavDurationMs(wav.subarray(0, 50))).toThrow("不完整");
  const invalid = Buffer.from(wav); invalid.writeUInt32LE(0, 28);
  expect(() => wavDurationMs(invalid)).toThrow("时长");
});

test("只请求首段, 最后缓冲段剩余五秒才补两段, 生成完不连续补下一批", async () => {
  jest.useFakeTimers();
  const parts = splitText(longText);
  const prepared = parts.map(() => Promise.withResolvers<Uint8Array>());
  const releases = parts.map(() => Promise.withResolvers<void>());
  const started = parts.map(() => Promise.withResolvers<void>());
  const submitted: number[] = [];
  const played: number[] = [];
  const abort = new AbortController();
  const done = speakText(longText, {
    signal: abort.signal,
    synthesize: (_text, signal) => {
      const index = submitted.length; submitted.push(index);
      return Promise.race([prepared[index].promise, cancelledAudio(signal)]);
    },
    play: async (wav, onStarted) => {
      const index = wav[44]; played.push(index); onStarted(); started[index].resolve();
      await releases[index].promise;
    },
  });
  expect(submitted).toEqual([0]);
  prepared[0].resolve(audio(0)); await started[0].promise;
  jest.advanceTimersByTime(14999); expect(submitted).toEqual([0]);
  jest.advanceTimersByTime(1); expect(submitted).toEqual([0, 1, 2]);
  prepared[2].resolve(audio(2)); prepared[1].resolve(audio(1));
  jest.advanceTimersByTime(100000); expect(submitted).toEqual([0, 1, 2]);
  releases[0].resolve(); await started[1].promise;
  jest.advanceTimersByTime(100000); expect(submitted).toEqual([0, 1, 2]);
  releases[1].resolve(); await started[2].promise;
  jest.advanceTimersByTime(14999); expect(submitted).toEqual([0, 1, 2]);
  jest.advanceTimersByTime(1); expect(submitted).toEqual([0, 1, 2, 3, 4]);
  expect(played).toEqual([0, 1, 2]);
  abort.abort(); releases[2].resolve();
  await expect(done).rejects.toThrow();
  jest.advanceTimersByTime(100000);
  expect(submitted).toEqual([0, 1, 2, 3, 4]);
});

test("播放停止后不再触发尚未到期的预取", async () => {
  jest.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController(); let submitted = 0;
  const done = speakText(longText, {
    signal: abort.signal,
    synthesize: async () => audio(submitted++),
    play: async (_wav, onStarted) => { onStarted(); started.resolve(); await release.promise; },
  });
  await started.promise;
  jest.advanceTimersByTime(10000); abort.abort();
  jest.advanceTimersByTime(100000);
  expect(submitted).toBe(1);
  release.resolve(); await expect(done).rejects.toThrow();
});

test("计时从播放器启动回调开始, 不从下载完成或写临时文件时开始", async () => {
  jest.useFakeTimers();
  const entered = Promise.withResolvers<void>();
  const start = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const running = Promise.withResolvers<void>();
  const abort = new AbortController(); let submitted = 0;
  const done = speakText(longText, {
    signal: abort.signal,
    synthesize: async () => audio(submitted++),
    play: async (_wav, onStarted) => {
      entered.resolve(); await start.promise; onStarted(); running.resolve(); await release.promise;
    },
  });
  await entered.promise; jest.advanceTimersByTime(100000); expect(submitted).toBe(1);
  start.resolve(); await running.promise;
  jest.advanceTimersByTime(14999); expect(submitted).toBe(1);
  jest.advanceTimersByTime(1); expect(submitted).toBe(3);
  abort.abort(); release.resolve(); await expect(done).rejects.toThrow();
});

test("已发出的两段预取在停止后取消且不播放", async () => {
  jest.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const signals: AbortSignal[] = []; const played: number[] = [];
  const done = speakText(longText, {
    signal: abort.signal,
    synthesize: (_text, signal) => {
      signals.push(signal);
      if (signals.length === 1) return Promise.resolve(audio(0));
      return cancelledAudio(signal);
    },
    play: async (wav, onStarted) => { played.push(wav[44]); onStarted(); started.resolve(); await release.promise; },
  });
  await started.promise; jest.advanceTimersByTime(15000);
  expect(signals.length).toBe(3); abort.abort(); release.resolve();
  await expect(done).rejects.toThrow();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(played).toEqual([0]);
});

test("播放失败清除定时补货, 错误上抛", async () => {
  jest.useFakeTimers();
  const failure = new Error("播放器失败"); let submitted = 0;
  await expect(speakText(longText, {
    signal: new AbortController().signal,
    synthesize: async () => audio(submitted++),
    play: async (_wav, onStarted) => { onStarted(); throw failure; },
  })).rejects.toBe(failure);
  jest.advanceTimersByTime(100000); expect(submitted).toBe(1);
});

test("预取提前失败不乱播, 到该段时传播错误并取消其余请求", async () => {
  jest.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("合成失败"); let submitted = 0;
  const played: number[] = [];
  const done = speakText(longText, {
    signal: new AbortController().signal,
    synthesize: (_text, signal) => {
      const index = submitted++;
      if (index === 0) return Promise.resolve(audio(0));
      if (index === 1) return Promise.reject(failure);
      return cancelledAudio(signal);
    },
    play: async (wav, onStarted) => { played.push(wav[44]); onStarted(); started.resolve(); await release.promise; },
  });
  await started.promise; jest.advanceTimersByTime(15000); release.resolve();
  await expect(done).rejects.toBe(failure);
  expect(played).toEqual([0]); expect(submitted).toBe(3);
});

test("播放实际提前结束可补下一批, 最后一批不越界且按序读完整篇", async () => {
  const played: number[] = []; let submitted = 0;
  await speakText(longText, {
    signal: new AbortController().signal,
    synthesize: async () => audio(submitted++),
    play: async (wav, onStarted) => { onStarted(); played.push(wav[44]); },
  });
  expect(played).toEqual(splitText(longText).map((_, index) => index));
  expect(submitted).toBe(splitText(longText).length);
});

test("开始前取消不提交, 首段等待期间取消不启动后续波次", async () => {
  const early = new AbortController(); early.abort(); let submitted = 0;
  await expect(speakText(longText, {
    signal: early.signal,
    synthesize: async () => { submitted++; return audio(0); },
    play: async () => { throw new Error("不应播放"); },
  })).rejects.toThrow();
  expect(submitted).toBe(0);
  const abort = new AbortController();
  const done = speakText(longText, {
    signal: abort.signal,
    synthesize: (_text, signal) => { submitted++; return cancelledAudio(signal); },
    play: async () => { throw new Error("不应播放"); },
  });
  expect(submitted).toBe(1); abort.abort(); await expect(done).rejects.toThrow();
  expect(submitted).toBe(1);
});
