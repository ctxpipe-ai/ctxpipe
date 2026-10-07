import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { defineLock, type LockStore } from "@tanstack/ai/locks"
import { and, eq, sql } from "drizzle-orm"
import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { markSandboxLifecycle } from "./sandbox-lifecycle-timing.js"

const LEASE_MS = 30_000
const expiresAt = sql`clock_timestamp() + interval '30 seconds'`

export type SandboxLockAcquired = (receipt: {
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
 * Run `fn` under `key` only if nobody holds it now, or frees it within
 * `waitMs`; otherwise return `{ busy: true }`. Cleanup uses this to leave a
 * conversation alone while a turn holds it.
 */
export async function withSandboxLockIfFree<T>(
  orgId: string,
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  waitMs = 0,
): Promise<{ busy: true } | { busy: false; value: T }> {
  try {
    const value = await postgresLocks(
      orgId,
      undefined,
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
  waitMs: number,
): LockStore {
  return defineLock({
    async withLock(key, fn) {
      assertNotInOrgDbContext()
      const owner = randomUUID()
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
        if (Date.now() - waitStarted >= waitMs) throw new SandboxLockBusy(key)
        await delay(250, undefined, { signal })
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
        markSandboxLifecycle("lock-released", {
          key,
          holdMs: Date.now() - holdStarted,
        })
      }
    },
  })
}
