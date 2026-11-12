import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { CheckpointStore, hashText, type CheckpointIdentity, type PlaybackStart } from "./checkpoint-cache";
import { sliceWav, speakText, type PlaybackRequest } from "./speech";

// SQLITE_BUSY 判据照抄 omp 官方先例 pi-utils sqlite.ts:453（错误对象 code 字符串前缀匹配）。
// 背景语义(#2421): BUSY 家族会绕过 busy handler 直接抛出, 属已知行为; 定时器回调里丢拍等下一拍重试即可。
function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code: unknown = error.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

const endpoint = "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
const voices = [
  { id: "longanlingxin", label: "龙安灵心" },
  { id: "longanlufeng", label: "龙安鲁风" },
  { id: "qwen-audio-3.0-tts-plus-longshanyancan", label: "龙山焰灿" },
  { id: "qwen-audio-3.0-tts-plus-longyingyifan", label: "龙鹰逸帆" },
  { id: "qwen-audio-3.0-tts-plus-longlanghongmo", label: "龙朗虹沫" },
  { id: "qwen-audio-3.0-tts-plus-longrongzhihe", label: "龙蓉芷荷" },
  { id: "qwen-audio-3.0-tts-plus-longcanzhuyue", label: "龙璨竹月" },
  { id: "longanhuan_v3.6", label: "龙安欢 (原音色)" },
] as const;

type Reply = { id: string; text: string };
type SpeechJob = {
  abort: AbortController;
  player?: ChildProcess;
  done?: Promise<void>;
  identity?: CheckpointIdentity;
  playbackId?: string;
  ownershipTimer?: Timer;
};

type PlaybackStarter = (identity: CheckpointIdentity, playbackId: string) => PlaybackStart;

function lastReply(ctx: ExtensionContext): Reply | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") continue;
    const text = entry.message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    return text ? { id: entry.id, text } : undefined;
  }
}

const credentialPath = join(homedir(), "local_doc/l_dev/my/video/pireel/.envrc.private");

function planKey(value: string | undefined): string | undefined {
  const key = value?.trim().replace(/^(['"])(.*)\1$/, "$2");
  return key?.startsWith("sk-sp-") ? key : undefined;
}

async function tokenPlanKey(): Promise<string> {
  const fromEnv = planKey(process.env.DASHSCOPE_API_KEY) ?? planKey(process.env.YINO_QWEN_TOKEN_PLAN_KEY);
  if (fromEnv) return fromEnv;
  const source = await readFile(credentialPath, "utf8");
  const assignment = source.match(/^\s*(?:export\s+)?YINO_QWEN_TOKEN_PLAN_KEY\s*=\s*([^\r\n]+)\s*$/m)?.[1];
  const key = planKey(assignment);
  if (!key) throw new Error("未找到有效的 Token Plan 套餐密钥");
  return key;
}


async function synthesize(text: string, key: string, voice: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen-audio-3.0-tts-plus", input: { text, voice, format: "wav", sample_rate: 24000 } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) throw new Error(`语音合成失败, HTTP ${response.status}`);
  const payload = await response.json() as { output?: { audio?: { url?: string } } };
  if (!payload.output?.audio?.url) throw new Error("语音合成响应缺少音频地址");
  const audioUrl = new URL(payload.output.audio.url);
  if (!audioUrl.hostname.endsWith(".oss-cn-beijing.aliyuncs.com")) throw new Error("语音服务返回了不受信任的音频地址");
  audioUrl.protocol = "https:";
  const audioResponse = await fetch(audioUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  if (!audioResponse.ok) throw new Error(`语音下载失败, HTTP ${audioResponse.status}`);
  const wav = new Uint8Array(await audioResponse.arrayBuffer());
  if (wav.length < 44 || Buffer.from(wav.subarray(0, 4)).toString("ascii") !== "RIFF") throw new Error("语音服务返回了无效的 WAV 音频");
  return wav;
}

export async function play(wav: Uint8Array, job: SpeechJob, onStarted: () => void, cursor: PlaybackRequest, timers?: { setInterval: ExtensionContext["setInterval"]; clearTimer: ExtensionContext["clearTimer"] }): Promise<void> {
  const playable = cursor.offsetMs > 0 ? sliceWav(wav, cursor.offsetMs) : wav;
  const directory = await mkdtemp(join(tmpdir(), "omp-read-aloud-"));
  const signal = job.abort.signal;
  let player: ChildProcess | undefined;
  const stopPlayer = () => player?.kill();

  let progressTimer: Timer | undefined;
  try {
    const path = join(directory, "speech.wav");
    await writeFile(path, playable, { mode: 0o600 });
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    player = spawn("/usr/bin/afplay", [path], { stdio: "ignore" });
    job.player = player;
    player.once("spawn", () => {
      try {
        onStarted();
        const startedAt = performance.now();
        cursor.onProgress(cursor.offsetMs);
        progressTimer = timers?.setInterval(() => {
          // BUSY 家族绕过 busy handler 是已知语义(#2421), 丢拍重试即可——进度游标会按真实时间外推, 丢拍无损;
          // 非 BUSY 必须照抛, 否则会掩盖真错误。
          try {
            cursor.onProgress(Math.min(cursor.durationMs, cursor.offsetMs + performance.now() - startedAt));
          } catch (error) {
            if (!isSqliteBusyError(error)) throw error;
          }
        }, 100);
      } catch (error) {
        player?.kill();
        reject(error);
      }
    });
    player.once("error", reject);
    player.once("exit", (code, exitSignal) => code === 0 || signal.aborted ? resolve() : reject(new Error(`音频播放失败: ${exitSignal ?? code}`)));
    signal.addEventListener("abort", stopPlayer, { once: true });
    if (signal.aborted) stopPlayer();
    await promise;
  } finally {
    // 受管句柄必须用 ctx.clearTimer 注销: 全局 clearInterval 不清宿主 #timers 登记, 每次播放会泄漏一个受管句柄
    if (progressTimer) timers?.clearTimer(progressTimer);
    signal.removeEventListener("abort", stopPlayer);
    job.player = undefined;
    await rm(directory, { recursive: true, force: true });
  }
}

type StartRequest = {
  text: string;
  voice: string;
  identity?: CheckpointIdentity;
  playbackId?: string;
  cursor?: PlaybackCursor;
};

async function runSpeech(ctx: ExtensionContext, job: SpeechJob, request: StartRequest, store: CheckpointStore): Promise<void> {
  const key = await tokenPlanKey();
  const playbackId = request.playbackId;
  const cache = playbackId ? {
    read: (index: number, part: string) => store.readAudio(playbackId, index, part),
    write: (index: number, part: string, wav: Uint8Array) => store.writeAudio(playbackId, index, part, wav),
    delete: (index: number, part: string) => store.deleteAudio(playbackId, index, part),
  } : undefined;
  let started = false;
  await speakText(request.text, {
    signal: job.abort.signal,
    startAt: request.cursor,
    cache,
    synthesize: (part, signal) => synthesize(part, key, request.voice, signal),
    play: async (wav, onStarted, cursor) => {
      await play(wav, job, () => {
        onStarted();
        if (started) return;
        started = true;
        ctx.ui.notify(request.identity ? "开始朗读, F8 暂停或继续, Shift+F8 从头播放" : "开始试听, 按 F8 停止", "info");
      }, cursor, { setInterval: ctx.setInterval, clearTimer: ctx.clearTimer });
    },
    onPartStarted: playbackId ? (index, offset, duration) => store.markStarted(playbackId, index, offset, duration) : undefined,
    onPartCompleted: playbackId ? index => store.markPartComplete(playbackId, index) : undefined,
    onPartProgress: playbackId ? (index, offset, duration) => store.markProgress(playbackId, index, offset, duration) : undefined,
    onComplete: playbackId ? count => store.markComplete(playbackId, count) : undefined,
  });
  if (!job.abort.signal.aborted) ctx.ui.notify(request.identity ? "朗读完成" : "试听完成", "info");
}

export default function (pi: ExtensionAPI): void {
  pi.setLabel("按需朗读");
  const store = new CheckpointStore();
  const instanceId = randomUUID();
  store.registerInstance(instanceId);
  // TODO(D): ExtensionContext.setInterval 需 ctx, 顶层作用域不可达(ExtensionAPI 无定时器方法); 若未来宿主暴露顶层受管定时器, 迁移到 ctx.setInterval。
  const heartbeat = setInterval(() => {
    // BUSY 家族绕过 busy handler 是已知语义(#2421), 心跳丢拍重试即可(活跃判定有 5s TTL, 丢一拍无语义损失);
    // 非 BUSY 必须照抛, 否则会掩盖真错误。
    try {
      store.heartbeat(instanceId);
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
    }
  }, 1000);
  const pluginConfig = async (args: string[], signal?: AbortSignal) => {
    const executable = Bun.which("omp");
    if (!executable) throw new Error("未找到 omp, 请将 OMP 可执行文件加入 PATH");
    const result = await pi.exec(executable, ["plugin", "config", ...args], { timeout: 20_000, signal });
    if (result.code !== 0) throw new Error(`插件设置操作失败: ${result.stderr.trim() || result.code}`);
    return result.stdout;
  };
  const currentVoice = async (signal?: AbortSignal): Promise<string> => {
    const config: unknown = JSON.parse(await pluginConfig(["get", "omp-read-aloud", "voice", "--json"], signal));
    if (!config || typeof config !== "object" || !("voice" in config) || typeof config.voice !== "string" || !voices.some(voice => voice.id === config.voice)) {
      throw new Error("插件中的音色设置无效");
    }
    return config.voice;
  };
  let active: SpeechJob | undefined;
  const stop = (job: SpeechJob) => {
    job.abort.abort();
    job.player?.kill();
  };
  const start = (ctx: ExtensionContext, request: StartRequest) => {
    const job: SpeechJob = {
      abort: new AbortController(),
      identity: request.identity,
      playbackId: request.playbackId,
    };
    active = job;
    ctx.ui.notify(request.identity ? "正在准备语音, F8 暂停或继续, Shift+F8 从头播放" : "正在准备试听, 按 F8 取消", "info");
    if (job.playbackId) {
      job.ownershipTimer = ctx.setInterval(() => {
        // BUSY 家族绕过 busy handler 是已知语义(#2421), 丢拍等下一轮(250ms)即可, 不会误判失主;
        // 非 BUSY 必须照抛, 否则会掩盖真错误(ctx.setInterval 的 throw containment 只隔离进程崩溃, 不静默)。
        try {
          if (!store.ownsPlayback(job.playbackId!)) stop(job);
        } catch (error) {
          if (!isSqliteBusyError(error)) throw error;
        }
      }, 250);
    }
    job.done = runSpeech(ctx, job, request, store).catch((error: unknown) => {
      if (!job.abort.signal.aborted) {
        if (job.playbackId) store.pausePlayback(job.playbackId);
        ctx.ui.notify(`朗读失败: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }).finally(() => {
      if (job.ownershipTimer) ctx.clearTimer(job.ownershipTimer);
      if (active === job) active = undefined;
    });
  };
  const pauseActive = () => {
    const checkpoint = store.current();
    if (checkpoint?.status === "playing") store.pausePlayback(checkpoint.playbackId);
    if (active) stop(active);
  };
  const beginPlayback: PlaybackStarter = (identity, playbackId) => store.beginPlayback(identity, instanceId, playbackId);
  const restartPlayback: PlaybackStarter = (identity, playbackId) => store.restartPlayback(identity, instanceId, playbackId);
  const currentReply = (ctx: ExtensionContext) => {
    const reply = lastReply(ctx);
    if (!reply) ctx.ui.notify("没有可朗读的完整回复", "warning");
    return reply;
  };
  const startReply = async (ctx: ExtensionContext, reply: Reply, claimPlayback: PlaybackStarter) => {
    try {
      const voice = await currentVoice();
      const sessionId = ctx.sessionManager.getSessionId();
      const identity = {
        sessionId, replyId: reply.id, textHash: hashText(reply.text), voice,
        synthesisKey: `${endpoint}|qwen-audio-3.0-tts-plus|wav|24000`,
      };
      const playbackId = randomUUID();
      const result = claimPlayback(identity, playbackId);
      if (result.kind === "paused") {
        const checkpoint = store.current();
        if (active?.playbackId === checkpoint?.playbackId) stop(active);
        ctx.ui.notify("已暂停朗读", "info");
        return;
      }
      if (active) stop(active);
      start(ctx, { text: reply.text, voice, identity, playbackId, cursor: result.cursor });
    } catch (error) {
      ctx.ui.notify(`朗读失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };
  const toggle = async (ctx: ExtensionContext) => {
    if (active && !active.identity) {
      stop(active);
      ctx.ui.notify("已停止试听", "info");
      return;
    }
    const reply = currentReply(ctx);
    if (!reply) return;
    const current = store.current();
    if (current?.status === "playing" && current.sessionId === ctx.sessionManager.getSessionId() &&
      current.replyId === reply.id && current.textHash === hashText(reply.text) && store.pauseIfLive(current.playbackId)) {
      if (active?.playbackId === current.playbackId) stop(active);
      ctx.ui.notify("已暂停朗读", "info");
      return;
    }
    await startReply(ctx, reply, beginPlayback);
  };
  const restartFromStart = async (ctx: ExtensionContext) => {
    if (active && !active.identity) stop(active);
    const reply = currentReply(ctx);
    if (reply) await startReply(ctx, reply, restartPlayback);
  };
  const invalidateCheckpoint = () => {
    store.clearAll();
    if (active) stop(active);
  };
  pi.on("session_start", (_event, ctx) => {
    const checkpoint = store.current();
    if (checkpoint && checkpoint.sessionId !== ctx.sessionManager.getSessionId()) store.clearAll();
  });
  pi.registerShortcut("f8", { description: "暂停或继续朗读最后一条回复", handler: ctx => toggle(ctx) });
  pi.registerShortcut("shift+f8", { description: "从头朗读最后一条回复", handler: restartFromStart });
  pi.registerCommand("read-aloud", { description: "暂停或继续朗读最后一条回复", handler: (_args, ctx) => toggle(ctx) });
  pi.registerCommand("read-aloud-voice", {
    description: "选择或试听中文朗读音色",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("音色选择需要交互界面", "warning");
        return;
      }
      try {
        const job = active;
        pauseActive();
        if (job) await job.done;
        const current = await currentVoice();
        const labels = voices.map(voice => `${voice.label}${voice.id === current ? " (当前)" : ""}`);
        const selected = await ctx.ui.select("选择音色", labels);
        if (!selected) return;
        const voice = voices[labels.indexOf(selected)];
        const action = await ctx.ui.select(`${voice.label}`, ["试听", "设为默认音色"]);
        if (action === "试听") {
          start(ctx, { text: `我是${voice.label}。你好，今天我们慢慢聊。希望这个声音听起来更自然，也更舒服。`, voice: voice.id });
        } else if (action === "设为默认音色") {
          await pluginConfig(["set", "omp-read-aloud", "voice", voice.id]);
          const effectiveVoice = await currentVoice();
          if (effectiveVoice !== current) store.clearAll();
          if (effectiveVoice !== voice.id) {
            const effectiveLabel = voices.find(candidate => candidate.id === effectiveVoice)?.label ?? effectiveVoice;
            ctx.ui.notify(`已保存全局默认音色 ${voice.label}, 但当前项目覆盖为 ${effectiveLabel}`, "warning");
          } else {
            ctx.ui.notify(`默认音色已设为 ${voice.label}`, "info");
          }
        }
      } catch (error) {
        ctx.ui.notify(`音色设置失败: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  pi.on("session_switch", invalidateCheckpoint);
  pi.on("session_branch", invalidateCheckpoint);
  pi.on("session_tree", invalidateCheckpoint);
  pi.on("session_shutdown", async () => {
    store.pauseInstance(instanceId);
    if (active) {
      const job = active;
      stop(job);
      await job.done;
    }
    clearInterval(heartbeat);
    store.unregisterInstance(instanceId);
    store.close();
  });
}
