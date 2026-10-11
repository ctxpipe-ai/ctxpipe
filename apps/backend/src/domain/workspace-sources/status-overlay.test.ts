import { describe, expect, it } from "vitest"
import type { SourceAdapter } from "./adapter.js"
import { overlaySourceStatus } from "./status-overlay.js"

const row = (
  sourceKey: string,
  connectionId: string | null,
  status = "ok",
) => ({
  sourceKey,
  provider: "confluence",
  connectionId,
  scope: { spaces: [{ key: sourceKey.toUpperCase(), pages: "all" }] },
  status: status as "ok" | "invalid" | "out_of_access" | "connection_missing",
  statusDetail: null as string | null,
})

describe("overlaySourceStatus", () => {
  it("shows a removed connection and a recorded sync problem at read time", async () => {
    const adapter: SourceAdapter = {
      provider: "confluence",
      managedPaths: () => ["confluence/"],
      fetch: async () => [],
      syncStatus: async ({ scope }) =>
        JSON.stringify(scope).includes("HR")
          ? {
              status: "out_of_access",
              detail: "Confluence space HR failed 3 syncs",
            }
          : null,
    }
    const rows = await overlaySourceStatus({
      orgId: "org_1",
      rows: [
        row("eng", "con_a"),
        row("hr", "con_a"),
        row("gone", "con_gone"),
        row("bad", "con_a", "invalid"),
      ],
      connectionIds: new Set(["con_a"]),
      adapters: { confluence: adapter },
    })
    expect(
      rows.map((item) => [item.sourceKey, item.status, item.statusDetail]),
    ).toEqual([
      ["eng", "ok", null],
      ["hr", "out_of_access", "Confluence space HR failed 3 syncs"],
      ["gone", "connection_missing", "The connection was removed"],
      ["bad", "invalid", null],
    ])
  })
})
