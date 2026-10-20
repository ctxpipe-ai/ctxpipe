import { Client } from "pg"
import { expect } from "vitest"

export async function withCanceledNativeInsert<T>(
  databaseUrl: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const locker = new Client({ connectionString: databaseUrl })
  await locker.connect()
  let pending: Promise<T> | undefined
  try {
    await locker.query("BEGIN")
    await locker.query("LOCK TABLE openworkflow.workflow_runs IN SHARE MODE")
    const lockPid = (
      await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid
    if (!lockPid) throw new Error("Fixture lock PID missing")
    pending = Promise.resolve(operation())
    void pending.catch(() => undefined)
    let blockedPid: number | undefined
    await expect
      .poll(
        async () => {
          await locker.query("SELECT pg_stat_clear_snapshot()")
          const rows = await locker.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE '%INSERT INTO%' AND query LIKE '%workflow_runs%'",
            [lockPid],
          )
          blockedPid = rows.rows[0]?.pid
          return blockedPid != null
        },
        { timeout: 5000 },
      )
      .toBe(true)
    await locker.query("SELECT pg_cancel_backend($1)", [blockedPid])
    return await pending
  } finally {
    await locker.query("ROLLBACK")
    await locker.end()
    await pending?.catch(() => undefined)
  }
}
