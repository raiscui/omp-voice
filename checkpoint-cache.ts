import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CheckpointIdentity {
  sessionId: string;
  replyId: string;
  textHash: string;
  voice: string;
  synthesisKey: string;
}

export interface PlaybackCursor {
  partIndex: number;
  offsetMs: number;
}

export type PlaybackStart =
  | { kind: "paused"; cursor: PlaybackCursor }
  | { kind: "started"; cursor: PlaybackCursor };

export interface CheckpointState extends CheckpointIdentity, PlaybackCursor {
  status: "playing" | "paused" | "complete";
  durationMs: number;
  updatedAt: number;
  instanceId: string;
  playbackId: string;
}

type StoredCheckpoint = {
  session_id: string;
  reply_id: string;
  text_hash: string;
  voice: string;
  synthesis_key: string;
  status: CheckpointState["status"];
  part_index: number;
  offset_ms: number;
  duration_ms: number;
  updated_at: number;
  instance_id: string;
  playback_id: string;
};

const ownerTimeoutMs = 5000;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function checkpointStorePath(): string {
  return join(homedir(), "Library", "Application Support", "omp-read-aloud", "checkpoint.sqlite");
}

function sameCheckpoint(stored: StoredCheckpoint, identity: CheckpointIdentity): boolean {
  return stored.session_id === identity.sessionId && stored.reply_id === identity.replyId &&
    stored.text_hash === identity.textHash && stored.voice === identity.voice && stored.synthesis_key === identity.synthesisKey;
}

function cursorAt(stored: StoredCheckpoint, now: number): PlaybackCursor {
  if (stored.status !== "playing" || stored.duration_ms <= 0) {
    return { partIndex: stored.part_index, offsetMs: stored.offset_ms };
  }
  const offsetMs = Math.min(stored.duration_ms, stored.offset_ms + Math.max(0, now - stored.updated_at));
  return offsetMs >= stored.duration_ms
    ? { partIndex: stored.part_index + 1, offsetMs: 0 }
    : { partIndex: stored.part_index, offsetMs };
}

function committedCursor(stored: StoredCheckpoint): PlaybackCursor {
  return { partIndex: stored.part_index, offsetMs: stored.offset_ms };
}

export class CheckpointStore {
  readonly #database: Database;

  constructor(path = checkpointStorePath()) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.#database = new Database(path);
    chmodSync(path, 0o600);
    // WAL+NORMAL 与 omp 自家 session-index.ts:101 一致; FULL 在 13 实例心跳下拉长持锁
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_id TEXT NOT NULL, reply_id TEXT NOT NULL, text_hash TEXT NOT NULL,
        voice TEXT NOT NULL, synthesis_key TEXT NOT NULL,
        status TEXT NOT NULL, part_index INTEGER NOT NULL, offset_ms REAL NOT NULL,
        duration_ms REAL NOT NULL, updated_at INTEGER NOT NULL,
        instance_id TEXT NOT NULL, playback_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audio (
        part_index INTEGER PRIMARY KEY, part_hash TEXT NOT NULL, wav BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instance (
        instance_id TEXT PRIMARY KEY, last_seen_at INTEGER NOT NULL
      );
    `);
  }

  registerInstance(instanceId: string, now = Date.now()): void {
    this.#database.transaction(() => {
      this.#database.query("DELETE FROM instance WHERE last_seen_at < ?").run(now - ownerTimeoutMs);
      this.#database.query("INSERT INTO instance VALUES (?, ?) ON CONFLICT(instance_id) DO UPDATE SET last_seen_at=excluded.last_seen_at").run(instanceId, now);
    }).immediate();

  }
  heartbeat(instanceId: string, now = Date.now()): void {
    this.#database.query("UPDATE instance SET last_seen_at=? WHERE instance_id=?").run(now, instanceId);
  }

  unregisterInstance(instanceId: string): void {
    this.#database.query("DELETE FROM instance WHERE instance_id=?").run(instanceId);
  }

  current(): CheckpointState | undefined {
    const stored = this.#database.query("SELECT * FROM checkpoint WHERE singleton=1").get() as StoredCheckpoint | null;
    return stored ? this.#toState(stored) : undefined;
  }

  #toState(stored: StoredCheckpoint): CheckpointState {
    return {
      sessionId: stored.session_id,
      replyId: stored.reply_id,
      textHash: stored.text_hash,
      voice: stored.voice,
      synthesisKey: stored.synthesis_key,
      status: stored.status,
      partIndex: stored.part_index,
      offsetMs: stored.offset_ms,
      durationMs: stored.duration_ms,
      updatedAt: stored.updated_at,
      instanceId: stored.instance_id,
      playbackId: stored.playback_id,
    };
  }

  beginPlayback(identity: CheckpointIdentity, instanceId: string, playbackId: string, now = Date.now()): PlaybackStart {
    let result: PlaybackStart;
    this.#database.transaction(() => {
      const stored = this.#database.query("SELECT * FROM checkpoint WHERE singleton=1").get() as StoredCheckpoint | null;
      result = this.#begin(stored, identity, instanceId, playbackId, now);
    }).immediate();
    try {
      this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // checkpoint 截断失败(含 BUSY 返回, #2421 语义)只影响 wal 回收, 不影响播放事务本身的正确性, 静默跳过
    }
    return result!;
  }

  restartPlayback(identity: CheckpointIdentity, instanceId: string, playbackId: string, now = Date.now()): PlaybackStart {
    let result: PlaybackStart;
    this.#database.transaction(() => {
      const stored = this.#database.query("SELECT * FROM checkpoint WHERE singleton=1").get() as StoredCheckpoint | null;
      if (!stored || !sameCheckpoint(stored, identity)) {
        result = this.#replace(identity, instanceId, playbackId, now);
        return;
      }
      const cursor = { partIndex: 0, offsetMs: 0 };
      this.#start(identity, instanceId, playbackId, cursor, now);
      result = { kind: "started", cursor };
    }).immediate();
    // 降频: restart 是高频路径, 不做 wal_checkpoint(TRUNCATE) 截断; 截断只影响 wal 回收, 不影响正确性
    return result!;
  }

  #begin(stored: StoredCheckpoint | null, identity: CheckpointIdentity, instanceId: string, playbackId: string, now: number): PlaybackStart {
    if (!stored || !sameCheckpoint(stored, identity)) return this.#replace(identity, instanceId, playbackId, now);
    const ownerIsLive = this.#instanceIsLive(stored.instance_id, now);
    if (stored.status === "playing" && ownerIsLive) return this.#pause(stored, now);
    const cursor = stored.status === "complete"
      ? { partIndex: 0, offsetMs: 0 }
      : stored.status === "playing" ? committedCursor(stored) : cursorAt(stored, now);
    this.#start(identity, instanceId, playbackId, cursor, now);
    return { kind: "started", cursor };
  }

  #instanceIsLive(instanceId: string, now: number): boolean {
    const row = this.#database.query("SELECT last_seen_at FROM instance WHERE instance_id=?").get(instanceId) as { last_seen_at: number } | null;
    return row !== null && now - row.last_seen_at < ownerTimeoutMs;
  }

  #replace(identity: CheckpointIdentity, instanceId: string, playbackId: string, now: number) {
    this.#database.query("DELETE FROM audio").run();
    this.#database.query("DELETE FROM checkpoint").run();
    this.#start(identity, instanceId, playbackId, { partIndex: 0, offsetMs: 0 }, now);
    return { kind: "started" as const, cursor: { partIndex: 0, offsetMs: 0 } };
  }

  #pause(stored: StoredCheckpoint, now: number) {
    const cursor = cursorAt(stored, now);
    this.#database.query(`UPDATE checkpoint SET status='paused', part_index=?, offset_ms=?, duration_ms=0, updated_at=? WHERE singleton=1`)
      .run(cursor.partIndex, cursor.offsetMs, now);
    return { kind: "paused" as const, cursor };
  }

  #start(identity: CheckpointIdentity, instanceId: string, playbackId: string, cursor: PlaybackCursor, now: number): void {
    this.#database.query(`
      INSERT INTO checkpoint VALUES (1, ?, ?, ?, ?, ?, 'playing', ?, ?, 0, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        session_id=excluded.session_id, reply_id=excluded.reply_id, text_hash=excluded.text_hash,
        voice=excluded.voice, synthesis_key=excluded.synthesis_key, status='playing',
        part_index=excluded.part_index, offset_ms=excluded.offset_ms, duration_ms=0,
        updated_at=excluded.updated_at, instance_id=excluded.instance_id, playback_id=excluded.playback_id
    `).run(identity.sessionId, identity.replyId, identity.textHash, identity.voice, identity.synthesisKey,
      cursor.partIndex, cursor.offsetMs, now, instanceId, playbackId);
  }

  markStarted(playbackId: string, partIndex: number, offsetMs: number, durationMs: number, now = Date.now()): void {
    this.#database.query(`UPDATE checkpoint SET part_index=?, offset_ms=?, duration_ms=?, updated_at=? WHERE singleton=1 AND playback_id=? AND status='playing'`)
      .run(partIndex, offsetMs, durationMs, now, playbackId);
  }

  markProgress(playbackId: string, partIndex: number, offsetMs: number, durationMs: number, now = Date.now()): void {
    this.#database.query(`UPDATE checkpoint SET offset_ms=?, duration_ms=?, updated_at=? WHERE singleton=1 AND playback_id=? AND part_index=? AND status='playing'`)
      .run(offsetMs, durationMs, now, playbackId, partIndex);
  }

  markPartComplete(playbackId: string, nextPartIndex: number, now = Date.now()): void {
    this.#database.query(`UPDATE checkpoint SET part_index=?, offset_ms=0, duration_ms=0, updated_at=? WHERE singleton=1 AND playback_id=? AND status='playing'`)
      .run(nextPartIndex, now, playbackId);
  }

  markComplete(playbackId: string, partCount: number, now = Date.now()): void {
    this.#database.query(`UPDATE checkpoint SET status='complete', part_index=?, offset_ms=0, duration_ms=0, updated_at=? WHERE singleton=1 AND playback_id=? AND status='playing'`)
      .run(partCount, now, playbackId);
  }

  pausePlayback(playbackId: string, now = Date.now()): boolean {
    let paused = false;
    this.#database.transaction(() => {
      const stored = this.#database.query("SELECT * FROM checkpoint WHERE singleton=1 AND playback_id=? AND status='playing'").get(playbackId) as StoredCheckpoint | null;
      if (!stored) return;
      this.#pause(stored, now);
      paused = true;
    }).immediate();
    return paused;
  }

  pauseIfLive(playbackId: string, now = Date.now()): PlaybackCursor | undefined {
    let cursor: PlaybackCursor | undefined;
    this.#database.transaction(() => {
      const stored = this.#database.query("SELECT * FROM checkpoint WHERE singleton=1 AND playback_id=? AND status='playing'").get(playbackId) as StoredCheckpoint | null;
      if (!stored || !this.#instanceIsLive(stored.instance_id, now)) return;
      cursor = this.#pause(stored, now).cursor;
    }).immediate();
    return cursor;
  }

  pauseInstance(instanceId: string, now = Date.now()): void {
    this.#database.transaction(() => {
      const stored = this.#database.query("SELECT * FROM checkpoint WHERE singleton=1 AND instance_id=? AND status='playing'").get(instanceId) as StoredCheckpoint | null;
      if (stored) this.#pause(stored, now);
    }).immediate();
  }

  ownsPlayback(playbackId: string): boolean {
    return this.#database.query("SELECT 1 FROM checkpoint WHERE singleton=1 AND playback_id=? AND status='playing'").get(playbackId) !== null;
  }

  readAudio(playbackId: string, partIndex: number, partText: string): Uint8Array | undefined {
    const row = this.#database.query(`
      SELECT audio.wav FROM audio
      JOIN checkpoint ON checkpoint.singleton=1
      WHERE checkpoint.playback_id=? AND checkpoint.status='playing'
        AND audio.part_index=? AND audio.part_hash=?
    `).get(playbackId, partIndex, hashText(partText)) as { wav: Uint8Array } | null;
    return row ? new Uint8Array(row.wav) : undefined;
  }

  writeAudio(playbackId: string, partIndex: number, partText: string, wav: Uint8Array): void {
    this.#database.query(`
      INSERT INTO audio(part_index, part_hash, wav)
      SELECT ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM checkpoint WHERE singleton=1 AND playback_id=? AND status='playing'
      )
      ON CONFLICT(part_index) DO UPDATE SET part_hash=excluded.part_hash, wav=excluded.wav
    `).run(partIndex, hashText(partText), wav, playbackId);
  }

  deleteAudio(playbackId: string, partIndex: number, partText: string): void {
    this.#database.query(`DELETE FROM audio WHERE part_index=? AND part_hash=? AND EXISTS (
      SELECT 1 FROM checkpoint WHERE singleton=1 AND playback_id=? AND status='playing'
    )`).run(partIndex, hashText(partText), playbackId);
  }

  clearAll(): void {
    this.#database.transaction(() => this.#clear()).immediate();
    try {
      this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // checkpoint 截断失败(含 BUSY 返回, #2421 语义)只影响 wal 回收, 不影响清理事务本身的正确性, 静默跳过
    }
  }

  #clear(): void {
    this.#database.query("DELETE FROM audio").run();
    this.#database.query("DELETE FROM checkpoint").run();
  }


  close(): void {
    this.#database.close();
  }
}
