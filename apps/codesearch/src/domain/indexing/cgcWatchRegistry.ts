import { resolve } from "node:path"

type WatchEntry = {
  cwd: string
  child: ReturnType<typeof Bun.spawn>
}

/** After this many consecutive failures, skip spawning until {@link WATCH_FAILURE_BACKOFF_MS} elapses. */
const MAX_WATCH_FAILURES = 5

/** Cooldown before retrying after repeated watch failures. */
const WATCH_FAILURE_BACKOFF_MS = 60_000

/**
 * One long-lived `cgc watch` child per absolute `KUZUDB_PATH`, so incremental graph
 * updates can stream while checkouts/index runs reuse the same Kùzu file.
 *
 * If the checkout directory changes for the same DB path, the previous watch is stopped
 * and a new one is spawned.
 */
const watchesByDbPath = new Map<string, WatchEntry>()

const watchFailureStreakByKey = new Map<string, number>()
const watchLastFailureAtByKey = new Map<string, number>()

function normalizeDbKey(kuzuDbPath: string): string {
  return resolve(kuzuDbPath)
}

function refreshWatchFailureBackoff(key: string): void {
  const last = watchLastFailureAtByKey.get(key)
  if (last === undefined) return
  if (Date.now() - last >= WATCH_FAILURE_BACKOFF_MS) {
    watchFailureStreakByKey.delete(key)
    watchLastFailureAtByKey.delete(key)
  }
}

function recordWatchFailure(key: string): number {
  const next = (watchFailureStreakByKey.get(key) ?? 0) + 1
  watchFailureStreakByKey.set(key, next)
  watchLastFailureAtByKey.set(key, Date.now())
  return next
}

function clearWatchFailure(key: string): void {
  watchFailureStreakByKey.delete(key)
  watchLastFailureAtByKey.delete(key)
}

function logCgcWatchError(params: {
  event: "spawn_failed" | "exited_nonzero"
  kuzuDbPath: string
  clonePath: string
  exitCode: number | null
  err?: unknown
  consecutiveFailures?: number
}): void {
  console.error("[codesearch] cgc watch error", params)
}

/**
 * Read stderr incrementally so the pipe buffer cannot fill and stall the child (pipe deadlock).
 */
function drainCgcWatchStderr(
  stderr: ReadableStream<Uint8Array> | undefined,
  ctx: { kuzuDbPath: string; clonePath: string },
): void {
  if (!stderr) return
  void (async () => {
    const reader = stderr.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        pending += decoder.decode(value, { stream: true })
        const parts = pending.split("\n")
        pending = parts.pop() ?? ""
        for (const line of parts) {
          if (line.trim()) {
            console.error("[codesearch] cgc watch stderr", {
              ...ctx,
              line: line.trimEnd(),
            })
          }
        }
      }
      if (pending.trim()) {
        console.error("[codesearch] cgc watch stderr", {
          ...ctx,
          line: pending.trimEnd(),
        })
      }
    } catch {
      // ignore
    }
  })()
}

/**
 * Ensures a `cgc watch .` process is running for `kuzuDbPath` with cwd `clonePath`.
 * Call **before** `git checkout` so filesystem changes from the checkout are observed.
 *
 * Failures are logged and ignored (environments without `cgc` still rely on `cgc index`).
 */
export function ensureCgcWatchBeforeCheckout(params: {
  kuzuDbPath: string
  clonePath: string
}): void {
  const key = normalizeDbKey(params.kuzuDbPath)
  refreshWatchFailureBackoff(key)

  const streak = watchFailureStreakByKey.get(key) ?? 0
  if (streak >= MAX_WATCH_FAILURES) {
    console.error("[codesearch] cgc watch skipped after repeated failures", {
      kuzuDbPath: params.kuzuDbPath,
      clonePath: params.clonePath,
      consecutiveFailures: streak,
      backoffMs: WATCH_FAILURE_BACKOFF_MS,
    })
    return
  }

  const existing = watchesByDbPath.get(key)
  if (existing && existing.cwd === params.clonePath) {
    return
  }

  if (existing) {
    try {
      existing.child.kill()
    } catch {
      // ignore
    }
    watchesByDbPath.delete(key)
  }

  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(["cgc", "watch", "."], {
      cwd: params.clonePath,
      env: {
        ...process.env,
        KUZUDB_PATH: params.kuzuDbPath,
        DATABASE_TYPE: "kuzudb",
      },
      stdout: "ignore",
      stderr: "pipe",
    })
  } catch (err) {
    const consecutiveFailures = recordWatchFailure(key)
    logCgcWatchError({
      event: "spawn_failed",
      kuzuDbPath: params.kuzuDbPath,
      clonePath: params.clonePath,
      exitCode: null,
      err,
      consecutiveFailures,
    })
    return
  }

  const stderr = child.stderr
  if (stderr && typeof stderr !== "number") {
    drainCgcWatchStderr(stderr, {
      kuzuDbPath: params.kuzuDbPath,
      clonePath: params.clonePath,
    })
  }

  watchesByDbPath.set(key, { cwd: params.clonePath, child })

  void child.exited.then((code) => {
    const cur = watchesByDbPath.get(key)
    if (cur?.child === child) {
      watchesByDbPath.delete(key)
    }
    if (code === 0) {
      clearWatchFailure(key)
      return
    }
    const consecutiveFailures = recordWatchFailure(key)
    logCgcWatchError({
      event: "exited_nonzero",
      kuzuDbPath: params.kuzuDbPath,
      clonePath: params.clonePath,
      exitCode: code,
      consecutiveFailures,
    })
  })
}
