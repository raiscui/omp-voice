type PreparedAudio = { audio: Uint8Array; durationMs: number } | { error: unknown };

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

type WavDataChunk = { start: number; size: number };

type WavLayout = {
  format: number;
  byteRate: number;
  blockAlign: number;
  formatChunk?: Uint8Array;
  dataChunks: WavDataChunk[];
  dataBytes: number;
};

function wavLayout(audio: Uint8Array): WavLayout {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (audio.length < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) {
    throw new Error("无法读取 WAV 播放时长");
  }
  let format = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let formatChunk: Uint8Array | undefined;
  let dataBytes = 0;
  const dataChunks: WavDataChunk[] = [];
  for (let offset = 12; offset + 8 <= audio.length;) {
    const kind = view.getUint32(offset);
    const declared = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const remaining = audio.length - start;
    // 语音服务把未知长度写成接近 0x7FFFFFFF 的占位值, 实际 PCM 一直延伸到文件末尾.
    if (declared > remaining && declared < 0x7f000000) throw new Error("WAV 数据块不完整");
    const size = Math.min(declared, remaining);
    const paddedEnd = start + size + (size % 2);
    if (declared <= remaining && paddedEnd > audio.length) throw new Error("WAV 数据块不完整");
    const end = Math.min(paddedEnd, audio.length);
    if (kind === 0x666d7420 && size >= 16) {
      format = view.getUint16(start, true);
      byteRate = view.getUint32(start + 8, true);
      blockAlign = view.getUint16(start + 12, true);
      formatChunk = audio.subarray(offset, end);
    } else if (kind === 0x64617461) {
      dataChunks.push({ start, size });
      dataBytes += size;
    }
    if (declared > remaining) break;
    offset = end;
  }
  if (!byteRate || !dataBytes) throw new Error("WAV 缺少有效的音频时长信息");
  return { format, byteRate, blockAlign, formatChunk, dataChunks, dataBytes };
}

export function wavDurationMs(audio: Uint8Array): number {
  const { byteRate, dataBytes } = wavLayout(audio);
  // WAV 的 byteRate 已包含声道数与采样位宽, 无需根据文本长度估算播放时长.
  return dataBytes / byteRate * 1000;
}

export function sliceWav(audio: Uint8Array, offsetMs: number): Uint8Array {
  const layout = wavLayout(audio);
  if (layout.format !== 1 || !layout.blockAlign || !layout.formatChunk) throw new Error("WAV 格式不支持精确续播");
  const offset = Math.max(0, Number.isFinite(offsetMs) ? offsetMs : 0);
  const frameOffset = Math.floor(offset * layout.byteRate / 1000 / layout.blockAlign) * layout.blockAlign;
  const bytesToSkip = Math.min(frameOffset, layout.dataBytes);
  const remainingBytes = layout.dataBytes - bytesToSkip;
  const formatLength = layout.formatChunk.length;
  const dataHeader = 12 + formatLength;
  const output = Buffer.alloc(dataHeader + 8 + remainingBytes + (remainingBytes % 2));
  const source = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  source.subarray(0, 12).copy(output);
  output.set(layout.formatChunk, 12);
  output.write("data", dataHeader);
  output.writeUInt32LE(remainingBytes, dataHeader + 4);
  let skipped = bytesToSkip;
  let destination = dataHeader + 8;
  for (const chunk of layout.dataChunks) {
    if (skipped >= chunk.size) {
      skipped -= chunk.size;
      continue;
    }
    const start = chunk.start + skipped;
    const size = chunk.size - skipped;
    output.set(source.subarray(start, start + size), destination);
    destination += size;
    skipped = 0;
  }
  output.writeUInt32LE(output.length - 8, 4);
  return new Uint8Array(output);
}

export interface PlaybackCursor {
  partIndex: number;
  offsetMs: number;
}

export interface PlaybackRequest extends PlaybackCursor {
  durationMs: number;
  onProgress(offsetMs: number): void;
}

interface SpeechCache {
  read(partIndex: number, text: string): Uint8Array | undefined;
  write(partIndex: number, text: string, audio: Uint8Array): void;
  delete(partIndex: number, text: string): void;
}

interface SpeechPipeline {
  signal: AbortSignal;
  startAt?: PlaybackCursor;
  cache?: SpeechCache;
  synthesize(text: string, signal: AbortSignal): Promise<Uint8Array>;
  play(audio: Uint8Array, onStarted: () => void, request: PlaybackRequest): Promise<void>;
  onPartStarted?(partIndex: number, offsetMs: number, durationMs: number): void;
  onPartProgress?(partIndex: number, offsetMs: number, durationMs: number): void;
  onPartCompleted?(nextPartIndex: number): void;
  onComplete?(partCount: number): void;
}


async function prepareAudio(index: number, text: string, signal: AbortSignal, pipeline: SpeechPipeline): Promise<PreparedAudio> {
  const cached = pipeline.cache?.read(index, text);
  if (cached) {
    try {
      return { audio: cached, durationMs: wavDurationMs(cached) };
    } catch {
      pipeline.cache?.delete(index, text);
    }
  }
  try {
    const audio = await pipeline.synthesize(text, signal);
    const durationMs = wavDurationMs(audio);
    signal.throwIfAborted();
    pipeline.cache?.write(index, text, audio);
    return { audio, durationMs };
  } catch (error) {
    return { error };
  }
}

export async function speakText(text: string, pipeline: SpeechPipeline): Promise<void> {
  const abort = new AbortController();
  const signal = AbortSignal.any([pipeline.signal, abort.signal]);
  const parts = splitText(text);
  const pending = new Map<number, Promise<PreparedAudio>>();
  const requestedCursor = pipeline.startAt ?? { partIndex: 0, offsetMs: 0 };
  const startAt = {
    partIndex: Math.min(parts.length, Math.max(0, Math.floor(requestedCursor.partIndex))),
    offsetMs: Number.isFinite(requestedCursor.offsetMs) ? Math.max(0, requestedCursor.offsetMs) : 0,
  };
  let submitted = startAt.partIndex;
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
      pending.set(index, prepareAudio(index, parts[index], signal, pipeline).then(
        value => value, error => ({ error }),
      ));
    }
  };
  try {
    signal.throwIfAborted();
    if (submitted < parts.length) submit(1);
    for (let index = startAt.partIndex; index < parts.length; index++) {
      const prepared = await pending.get(index)!;
      pending.delete(index);
      signal.throwIfAborted();
      if ("error" in prepared) throw prepared.error;
      const offsetMs = index === startAt.partIndex ? startAt.offsetMs : 0;
      if (offsetMs >= prepared.durationMs) {
        pipeline.onPartCompleted?.(index + 1);
        if (!pending.size) submit(2);
        continue;
      }
      try {
        await pipeline.play(prepared.audio, () => {
          pipeline.onPartStarted?.(index, offsetMs, prepared.durationMs);
          if (pending.size || submitted === parts.length || signal.aborted) return;
          timer = setTimeout(() => {
            timer = undefined;
            submit(2);
          }, Math.max(0, prepared.durationMs - offsetMs - 5000));
        }, {
          partIndex: index,
          offsetMs,
          durationMs: prepared.durationMs,
          onProgress: currentOffsetMs => pipeline.onPartProgress?.(index, currentOffsetMs, prepared.durationMs),
        });
      } finally { clearPrefetch(); }
      signal.throwIfAborted();
      pipeline.onPartCompleted?.(index + 1);
      // 播放器提前结束或计时回调尚未执行时, 此刻已无缓冲, 才允许补下一小批.
      if (!pending.size) submit(2);
    }
    pipeline.onComplete?.(parts.length);
  } finally {
    clearPrefetch();
    signal.removeEventListener("abort", clearPrefetch);
    abort.abort();
    await Promise.allSettled(pending.values());
    pending.clear();
  }
}

