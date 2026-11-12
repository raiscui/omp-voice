import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "./checkpoint-cache";

// 锁定崩溃前提：多个连接写同一 checkpoint.sqlite 时，写锁被占用的一方必然抛 SQLITE_BUSY 家族错误。
// CheckpointStore 的 busy_timeout 固定 5000ms 且 #database 私有，无法从外部调低；因此持锁方与受害方
// 都按 omp 官方 sqlite.ts 的用法在测试里用 bun:sqlite 直接开连接：受害连接把 busy_timeout 降到 100ms
// （对已打开连接追加 pragma 安全），让「阻塞后抛错」确定落在断言窗口内，而不是等满 5 秒。

const BUSY_ASSERT_WINDOW_MS = 2000;

function sqliteErrorCode(error: unknown): string | undefined {
  return (error as Error & { code?: string } | null)?.code;
}

async function withTempStore(run: (store: CheckpointStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "omp-read-aloud-contention-"));
  const path = join(directory, "checkpoint.sqlite");
  const store = new CheckpointStore(path);
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("另一连接持写锁时写入同步抛 SQLITE_BUSY 且在 2 秒内失败", async () => {
  await withTempStore(async (store, path) => {
    // 先注册实例行：heartbeat 的 UPDATE 必须匹配到行，锁升级才会真实发生
    store.registerInstance("instance-b");
    const locker = new Database(path);
    const victim = new Database(path);
    victim.exec("PRAGMA busy_timeout=100");
    let holdingLock = false;
    try {
      locker.exec("BEGIN IMMEDIATE");
      holdingLock = true;
      const started = Date.now();
      let thrown: unknown;
      try {
        victim.query("UPDATE instance SET last_seen_at=? WHERE instance_id=?").run(Date.now(), "instance-b");
      } catch (error) {
        thrown = error;
      }
      const elapsed = Date.now() - started;
      expect(thrown).toBeInstanceOf(Error);
      expect(sqliteErrorCode(thrown)).toMatch(/^SQLITE_BUSY/);
      expect(elapsed).toBeLessThan(BUSY_ASSERT_WINDOW_MS);
    } finally {
      if (holdingLock) locker.exec("ROLLBACK");
      locker.close();
      victim.close();
    }
  });
});

test("写锁释放后同一写入重试成功且值已持久化", async () => {
  await withTempStore(async (store, path) => {
    store.registerInstance("instance-b");
    const locker = new Database(path);
    const victim = new Database(path);
    victim.exec("PRAGMA busy_timeout=100");
    const updateHeartbeat = victim.query("UPDATE instance SET last_seen_at=? WHERE instance_id=?");
    let holdingLock = false;
    try {
      locker.exec("BEGIN IMMEDIATE");
      holdingLock = true;
      // 持锁期间同一语句被暂时拒绝，且确因 SQLITE_BUSY 而非其他错误
      let blocked: unknown;
      try {
        updateHeartbeat.run(1111111111111, "instance-b");
      } catch (error) {
        blocked = error;
      }
      expect(sqliteErrorCode(blocked)).toMatch(/^SQLITE_BUSY/);
      // 释放锁后同一连接重试同一语句应成功，值已写入
      locker.exec("ROLLBACK");
      holdingLock = false;
      updateHeartbeat.run(2222222222222, "instance-b");
      const row = victim.query("SELECT last_seen_at FROM instance WHERE instance_id=?").get("instance-b") as { last_seen_at: number };
      expect(row.last_seen_at).toBe(2222222222222);
      // store 自身的心跳（真实写入路径）在锁释放后同样成功
      store.heartbeat("instance-b", 3333333333333);
      const rowAfter = victim.query("SELECT last_seen_at FROM instance WHERE instance_id=?").get("instance-b") as { last_seen_at: number };
      expect(rowAfter.last_seen_at).toBe(3333333333333);
    } finally {
      if (holdingLock) locker.exec("ROLLBACK");
      locker.close();
      victim.close();
    }
  });
});
