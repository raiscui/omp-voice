type PreparedAudio = { audio: Uint8Array } | { error: unknown };

export function splitText(text: string): string[] {
  if (!text.trim()) return [];
  const parts: string[] = [];
  let current = "";
  let length = 0;
  // 空文本和纯空白不提交; 按 Unicode 码点计数, 单字符与无标点长句也必须完整保留.
  for (const character of text) {
    current += character;
    length++;
    const first = parts.length === 0;
    if (length >= (first ? 60 : 180) || (length >= (first ? 16 : 60) && /[。！？.!?，,；;：:\n]/u.test(character))) {
      parts.push(current);
      current = "";
      length = 0;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function wavDurationMs(audio: Uint8Array): number {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (audio.length < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) {
    throw new Error("无法读取 WAV 播放时长");
  }
  let byteRate = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const kind = view.getUint32(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (size > audio.length - start) throw new Error("WAV 数据块不完整");
    if (kind === 0x666d7420 && size >= 16) byteRate = view.getUint32(start + 8, true);
    if (kind === 0x64617461) dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (!byteRate || !dataBytes) throw new Error("WAV 缺少有效的音频时长信息");
  // WAV 的 byteRate 已包含声道数与采样位宽, 无需根据文本长度估算播放时长.
  return dataBytes / byteRate * 1000;
}

interface SpeechPipeline {
  signal: AbortSignal;
  synthesize(text: string, signal: AbortSignal): Promise<Uint8Array>;
  play(audio: Uint8Array, onStarted: () => void): Promise<void>;
}

export async function speakText(text: string, pipeline: SpeechPipeline): Promise<void> {
  const abort = new AbortController();
  const signal = AbortSignal.any([pipeline.signal, abort.signal]);
  const parts = splitText(text);
  const pending = new Map<number, Promise<PreparedAudio>>();
  let submitted = 0;
  let timer: Timer | undefined;
  const clearPrefetch = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  signal.addEventListener("abort", clearPrefetch, { once: true });
  const submit = (count: number) => {
    const end = Math.min(submitted + count, parts.length);
    while (submitted < end && !signal.aborted) {
      const index = submitted++;
      // 立即接收乱序失败, 轮到该段时再抛出, 避免后台 Promise 出现未处理拒绝.
      pending.set(index, pipeline.synthesize(parts[index], signal).then(
        audio => ({ audio }), error => ({ error }),
      ));
    }
  };
  try {
    signal.throwIfAborted();
    submit(1);
    for (let index = 0; index < parts.length; index++) {
      const prepared = await pending.get(index)!;
      pending.delete(index);
      signal.throwIfAborted();
      if ("error" in prepared) throw prepared.error;
      const duration = wavDurationMs(prepared.audio);
      try {
        await pipeline.play(prepared.audio, () => {
          if (pending.size || submitted === parts.length || signal.aborted) return;
          timer = setTimeout(() => {
            timer = undefined;
            submit(2);
          }, Math.max(0, duration - 5000));
        });
      } finally { clearPrefetch(); }
      signal.throwIfAborted();
      // 播放器提前结束或计时回调尚未执行时, 此刻已无缓冲, 才允许补下一小批.
      if (!pending.size) submit(2);
    }
  } finally {
    clearPrefetch();
    signal.removeEventListener("abort", clearPrefetch);
    abort.abort();
    await Promise.allSettled(pending.values());
    pending.clear();
  }
}
