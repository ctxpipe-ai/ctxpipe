import type { SourceAdapter } from "./adapter.js"
import type { SourceProvider, SourceStatus } from "./sources-file.js"

type OverlayRow = {
  provider: string | null
  connectionId: string | null
  scope: Record<string, unknown>
  status: SourceStatus
  statusDetail: string | null
}

/**
 * The read-time status of projected sources: a removed connection shows as
 * missing before the next projection, and an `ok` source shows the sync
 * problem that its adapter recorded (for example a page that keeps failing).
 */
export async function overlaySourceStatus<R extends OverlayRow>(input: {
  orgId: string
  rows: readonly R[]
  connectionIds: ReadonlySet<string>
  adapters: Partial<Record<SourceProvider, SourceAdapter>>
}): Promise<R[]> {
  return Promise.all(
    input.rows.map(async (row): Promise<R> => {
      if (!row.connectionId) return row
      if (
        !input.connectionIds.has(row.connectionId) &&
        (row.status === "ok" || row.status === "out_of_access")
      )
        return {
          ...row,
          status: "connection_missing",
          statusDetail: "The connection was removed",
        }
      const adapter = input.adapters[row.provider as SourceProvider]
      if (row.status !== "ok" || !adapter?.syncStatus) return row
      const problem = await adapter.syncStatus({
        orgId: input.orgId,
        connectionId: row.connectionId,
        scope: row.scope,
      })
      return problem
        ? { ...row, status: problem.status, statusDetail: problem.detail }
        : row
    }),
  )
}
