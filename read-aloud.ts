import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { speakText } from "./speech";

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

type SpeechJob = { abort: AbortController; player?: ChildProcess; done?: Promise<void> };

function lastReply(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") continue;
    return entry.message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
  }
  return "";
}

function tokenPlanKey(): string {
  const key = process.env.DASHSCOPE_API_KEY?.trim();
  if (!key?.startsWith("sk-sp-")) throw new Error("请设置有效的 Token Plan 套餐密钥 DASHSCOPE_API_KEY (sk-sp- 前缀)");
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

async function play(wav: Uint8Array, job: SpeechJob, onStarted: () => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "omp-read-aloud-"));
  try {
    const path = join(directory, "speech.wav");
    await writeFile(path, wav, { mode: 0o600 });
    job.abort.signal.throwIfAborted();
    const player = spawn("/usr/bin/afplay", [path], { stdio: "ignore" });
    player.once("spawn", onStarted);
    job.player = player;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    player.once("error", reject);
    player.once("exit", (code, signal) => code === 0 || job.abort.signal.aborted ? resolve() : reject(new Error(`音频播放失败: ${signal ?? code}`)));
    await promise;
  } finally {
    job.player = undefined;
    await rm(directory, { recursive: true, force: true });
  }
}

export default function (pi: ExtensionAPI): void {
  pi.setLabel("按需朗读");
  let active: SpeechJob | undefined;
  const cancel = () => {
    if (!active) return;
    active.abort.abort();
    active.player?.kill();
  };
  const pluginConfig = async (args: string[], signal?: AbortSignal) => {
    const omp = Bun.which("omp");
    if (!omp) throw new Error("未找到 omp, 请将 OMP 可执行文件加入 PATH");
    const result = await pi.exec(omp, ["plugin", "config", ...args], { timeout: 20_000, signal });
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
  const start = (ctx: ExtensionContext, text: string, previewVoice?: string) => {
    const job: SpeechJob = { abort: new AbortController() };
    active = job;
    ctx.ui.notify(previewVoice ? "正在准备试听, 按 F8 取消" : "正在准备首段语音, 后续按播放进度生成, 按 F8 取消", "info");
    job.done = (async () => {
      const voice = previewVoice ?? await currentVoice(job.abort.signal);
      const key = tokenPlanKey();
      let first = true;
      await speakText(text, {
        signal: job.abort.signal,
        synthesize: (part, signal) => synthesize(part, key, voice, signal),
        play: async (wav, onStarted) => {
          if (first) {
            first = false;
            ctx.ui.notify(previewVoice ? "开始试听, 按 F8 停止" : "开始朗读, 快播完时才补充后续语音, 按 F8 停止", "info");
          }
          await play(wav, job, onStarted);
        },
      });
      if (!job.abort.signal.aborted) ctx.ui.notify(previewVoice ? "试听完成" : "朗读完成", "info");
    })().catch((error: unknown) => {
      if (!job.abort.signal.aborted) ctx.ui.notify(`朗读失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    }).finally(() => { if (active === job) active = undefined; });
  };
  const toggle = (ctx: ExtensionContext) => {
    if (active) {
      cancel();
      ctx.ui.notify("已停止朗读", "info");
      return;
    }
    const text = lastReply(ctx);
    if (!text) {
      ctx.ui.notify("没有可朗读的完整回复", "warning");
      return;
    }
    start(ctx, text);
  };
  pi.registerShortcut("f8", { description: "朗读或停止朗读最后一条回复", handler: toggle });
  pi.registerCommand("read-aloud", { description: "朗读或停止朗读最后一条回复", handler: (_args, ctx) => toggle(ctx) });
  pi.registerCommand("read-aloud-voice", {
    description: "选择或试听中文朗读音色",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("音色选择需要交互界面", "warning");
        return;
      }
      try {
        if (active) {
          const job = active;
          cancel();
          await job.done;
          ctx.ui.notify("已停止朗读", "info");
        }
        const current = await currentVoice();
        const labels = voices.map(voice => `${voice.label}${voice.id === current ? " (当前)" : ""}`);
        const selected = await ctx.ui.select("选择音色", labels);
        if (!selected) return;
        const voice = voices[labels.indexOf(selected)];
        const action = await ctx.ui.select(`${voice.label}`, ["试听", "设为默认音色"]);
        if (action === "试听") {
          if (active) {
            ctx.ui.notify("请先按 F8 停止当前朗读", "warning");
            return;
          }
          start(ctx, `我是${voice.label}。你好，今天我们慢慢聊。希望这个声音听起来更自然，也更舒服。`, voice.id);
        } else if (action === "设为默认音色") {
          await pluginConfig(["set", "omp-read-aloud", "voice", voice.id]);
          const effectiveVoice = await currentVoice();
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
  pi.on("session_switch", cancel);
  pi.on("session_branch", cancel);
  pi.on("session_tree", cancel);
  pi.on("session_shutdown", cancel);
}
