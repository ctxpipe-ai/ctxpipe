import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { defineLock, type LockStore } from "@tanstack/ai/locks"
import { and, eq, sql } from "drizzle-orm"
import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { markSandboxLifecycle } from "./sandbox-lifecycle-timing.js"

const LEASE_MS = 30_000
const expiresAt = sql`clock_timestamp() + interval '30 seconds'`

type SandboxLockAcquired = (receipt: {
  key: string
  owner: string
}) => void | Promise<void>

/** Postgres implementation of TanStack's native mutex, without held connections. */
export function postgresSandboxLocks(
  orgId: string,
  abortController?: AbortController,
  scopeKey?: string,
  onAcquired?: SandboxLockAcquired,
): LockStore {
  if (scopeKey) {
    const controller = abortController ?? new AbortController()
    const scoped = postgresSandboxLocks(orgId, controller)
    const locks = postgresSandboxLocks(orgId, controller, undefined, onAcquired)
    return defineLock({
      withLock: (key, fn) =>
        scoped.withLock(scopeKey, () => locks.withLock(key, fn)),
    })
  }
  return postgresLocks(orgId, abortController, onAcquired, Infinity)
}

class SandboxLockBusy extends Error {}

/**
 * Waiters in this process, by org and key. A release wakes them at once, so
 * a turn that waits behind a prepare starts as soon as the prepare ends. The
 * poll stays for a holder in another process and for an expired lease.
 */
const waiters = new Map<string, Set<() => void>>()

async function waitForRelease(
  name: string,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  const woken = new AbortController()
  const wake = () => woken.abort()
  const set = waiters.get(name) ?? new Set()
  waiters.set(name, set)
  set.add(wake)
  try {
    await delay(ms, undefined, {
      signal: AbortSignal.any([signal, woken.signal]),
    }).catch((error) => {
      if (!woken.signal.aborted || signal.aborted) throw error
    })
  } finally {
    set.delete(wake)
    if (!set.size && waiters.get(name) === set) waiters.delete(name)
  }
}

function wakeWaiters(name: string): void {
  for (const wake of waiters.get(name) ?? []) wake()
}

/**
 * Run `fn` under `key` only if nobody holds it now, or if the holder releases
 * it within `waitMs`; otherwise return `{ busy: true }`. A caller uses this
 * when it must not wait for a running turn. `abortController` aborts `fn` the
 * same way as in `postgresSandboxLocks`.
 */
export async function withSandboxLockIfFree<T>(
  orgId: string,
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  abortController?: AbortController,
  waitMs = 0,
): Promise<{ busy: true } | { busy: false; value: T }> {
  try {
    const value = await postgresLocks(
      orgId,
      abortController,
      undefined,
      waitMs,
    ).withLock(key, fn)
    return { busy: false, value }
  } catch (error) {
    if (error instanceof SandboxLockBusy) return { busy: true }
    throw error
  }
}

function postgresLocks(
  orgId: string,
  abortController: AbortController | undefined,
  onAcquired: SandboxLockAcquired | undefined,
  /** How long to wait for a holder to release the lock. */
  waitMs: number,
): LockStore {
  return defineLock({
    async withLock(key, fn) {
      assertNotInOrgDbContext()
      const owner = randomUUID()
      const waitName = `${orgId}:${key}`
      const lost = new AbortController()
      const signal = abortController
        ? AbortSignal.any([lost.signal, abortController.signal])
        : lost.signal
      const owned = and(
        eq(sandboxLocks.key, key),
        eq(sandboxLocks.owner, owner),
      )
      let deadline = 0
      const waitStarted = Date.now()
      for (;;) {
        signal.throwIfAborted()
        const startedAt = Date.now()
        const acquired = await withOrgDbContext(orgId, (db) =>
          db
            .insert(sandboxLocks)
            .values({ orgId, key, owner, expiresAt })
            .onConflictDoUpdate({
              target: [sandboxLocks.orgId, sandboxLocks.key],
              set: { owner, expiresAt },
              setWhere: sql`${sandboxLocks.expiresAt} <= clock_timestamp()`,
            })
            .returning({ owner: sandboxLocks.owner }),
        )
        if (acquired.length) {
          deadline = startedAt + LEASE_MS
          markSandboxLifecycle("lock-wait", {
            key,
            ms: Date.now() - waitStarted,
          })
          markSandboxLifecycle("lock-acquired", { key })
          break
        }
        const left = waitStarted + waitMs - Date.now()
        if (left <= 0) throw new SandboxLockBusy(key)
        await waitForRelease(waitName, Math.min(250, left), signal)
      }
      const holdStarted = Date.now()
      const stopped = new AbortController()
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      const lose = (reason: unknown) => {
        lost.abort(reason)
        abortController?.abort(reason)
      }
      const armDeadline = () => {
        clearTimeout(deadlineTimer)
        if (deadline <= Date.now()) {
          lose(new Error("Sandbox lock ownership expired"))
          return
        }
        deadlineTimer = setTimeout(
          () => lose(new Error("Sandbox lock ownership expired")),
          Math.max(0, deadline - Date.now()),
        )
      }
      armDeadline()
      const renew = (async () => {
        try {
          while (!stopped.signal.aborted && !signal.aborted) {
            await delay(10_000, undefined, { signal: stopped.signal })
            if (signal.aborted) return
            const startedAt = Date.now()
            const renewed = await withOrgDbContext(orgId, (db) =>
              db
                .update(sandboxLocks)
                .set({ expiresAt })
                .where(
                  and(
                    owned,
                    sql`${sandboxLocks.expiresAt} > clock_timestamp()`,
                  ),
                )
                .returning({ owner: sandboxLocks.owner }),
            )
            if (!renewed.length) throw new Error("Sandbox lock ownership lost")
            if (signal.aborted) return
            deadline = startedAt + LEASE_MS
            armDeadline()
          }
        } catch (error) {
          if (!stopped.signal.aborted) lose(error)
        }
      })()
      try {
        signal.throwIfAborted()
        await onAcquired?.({ key, owner })
        signal.throwIfAborted()
        const result = await fn(signal)
        if (deadline <= Date.now())
          lose(new Error("Sandbox lock ownership expired"))
        signal.throwIfAborted()
        return result
      } finally {
        stopped.abort()
        clearTimeout(deadlineTimer)
        await renew
        await withOrgDbContext(orgId, (db) =>
          db.delete(sandboxLocks).where(owned),
        )
        wakeWaiters(waitName)
        markSandboxLifecycle("lock-released", {
          key,
          holdMs: Date.now() - holdStarted,
        })
      }
    },
  })
}
