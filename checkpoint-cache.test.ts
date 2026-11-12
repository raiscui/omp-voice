import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, hashText, type CheckpointIdentity } from "./checkpoint-cache";

const text = "跨重启复用";
const identity: CheckpointIdentity = {
  sessionId: "session-a",
  replyId: "reply-a",
  textHash: hashText(text),
  voice: "longanlingxin",
  synthesisKey: "qwen-audio-3.0-tts-plus/24000/wav",
};
const wav = Uint8Array.from([82, 73, 70, 70, 1, 2, 3]);
const stores: CheckpointStore[] = [];

async function withStore(run: (store: CheckpointStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "omp-read-aloud-test-"));
  const path = join(directory, "checkpoint.sqlite");
  const store = new CheckpointStore(path);
  stores.push(store);
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
    stores.splice(stores.indexOf(store), 1);
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("已暂停的片段与位置能从另一个数据库连接恢复", async () => {
  await withStore(async (store, path) => {
    store.registerInstance("instance-a", 1000);
    store.beginPlayback(identity, "instance-a", "playback-a", 1000);
    store.writeAudio("playback-a", 0, text, wav);
    store.markStarted("playback-a", 0, 0, 12_000, 1000);
    store.markProgress("playback-a", 0, 3200, 12_000, 3200);

    const restarted = new CheckpointStore(path);
    try {
      restarted.registerInstance("instance-b", 10_000);
      const result = restarted.beginPlayback(identity, "instance-b", "playback-b", 10_000);
      expect(result).toEqual({ kind: "started", cursor: { partIndex: 0, offsetMs: 3200 } });
      expect(restarted.readAudio("playback-b", 0, text)).toEqual(wav);
      const restart = restarted.restartPlayback(identity, "instance-b", "playback-c", 11_000);
      expect(restart).toEqual({ kind: "started", cursor: { partIndex: 0, offsetMs: 0 } });
      expect(restarted.readAudio("playback-c", 0, text)).toEqual(wav);
    } finally {
      restarted.close();
    }
  });
});

test("最新回复或音色替换全局缓存并阻止旧播放写入", async () => {
  await withStore(async store => {
    store.registerInstance("instance-a", 1000);
    store.beginPlayback(identity, "instance-a", "playback-a", 1000);
    store.writeAudio("playback-a", 0, text, wav);

    const nextReply = { ...identity, replyId: "reply-b" };
    store.beginPlayback(nextReply, "instance-a", "playback-b", 2000);
    store.writeAudio("playback-a", 1, "旧请求", wav);
    expect(store.readAudio("playback-a", 0, text)).toBeUndefined();
    expect(store.readAudio("playback-b", 0, text)).toBeUndefined();

    store.writeAudio("playback-b", 0, text, wav);
    const nextVoice = { ...nextReply, voice: "longanlufeng" };
    store.beginPlayback(nextVoice, "instance-a", "playback-c", 3000);
    expect(store.readAudio("playback-c", 0, text)).toBeUndefined();
    expect(store.current()?.voice).toBe("longanlufeng");
  });
});

test("另一个实例对正在播放的同一检查点按 F8 会记录暂停位置", async () => {
  await withStore(async store => {
    store.registerInstance("instance-a", 1000);
    store.registerInstance("instance-b", 1000);
    store.beginPlayback(identity, "instance-a", "playback-a", 1000);
    store.writeAudio("playback-a", 1, "已预取片段", wav);
    store.markStarted("playback-a", 0, 0, 20_000, 1000);
    store.markProgress("playback-a", 0, 1000, 20_000, 2000);

    const result = store.beginPlayback(identity, "instance-b", "playback-b", 2400);
    expect(result).toEqual({ kind: "paused", cursor: { partIndex: 0, offsetMs: 1400 } });
    expect(store.current()?.status).toBe("paused");
    store.writeAudio("playback-a", 2, "暂停后的旧请求", wav);

    const resumed = store.beginPlayback(identity, "instance-b", "playback-b", 2600);
    expect(resumed).toEqual({ kind: "started", cursor: { partIndex: 0, offsetMs: 1400 } });
    expect(store.readAudio("playback-b", 1, "已预取片段")).toEqual(wav);
    expect(store.readAudio("playback-b", 2, "暂停后的旧请求")).toBeUndefined();
  });
});

test("全局清空时移除检查点与所有已缓存音频", async () => {
  await withStore(async store => {
    store.registerInstance("instance-a", 1000);
    store.beginPlayback(identity, "instance-a", "playback-a", 1000);
    store.writeAudio("playback-a", 0, text, wav);
    store.clearAll();
    expect(store.current()).toBeUndefined();
  });
});
