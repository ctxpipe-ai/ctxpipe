import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { defineLock, type LockStore } from "@tanstack/ai/locks"
import { and, eq, sql } from "drizzle-orm"
import { assertNotInOrgDbContext, withOrgDbContext } from "../../db/client.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"

const LEASE_MS = 30_000
const expiresAt = sql`clock_timestamp() + interval '30 seconds'`

/** Postgres implementation of TanStack's native mutex, without held connections. */
export function postgresSandboxLocks(
  orgId: string,
  abortController?: AbortController,
  scopeKey?: string,
): LockStore {
  if (scopeKey) {
    const controller = abortController ?? new AbortController()
    const locks = postgresSandboxLocks(orgId, controller)
    return defineLock({
      withLock: (key, fn) =>
        locks.withLock(scopeKey, () => locks.withLock(key, fn)),
    })
  }
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
          break
        }
        await delay(250, undefined, { signal })
      }
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
      }
    },
  })
}
