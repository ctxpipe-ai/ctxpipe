import { describe, expect, it } from "vitest"
import type { ProjectionState, WorkspaceRevision } from "./revision.js"
import {
  failedPhaseRetryDue,
  servedSha,
  shouldEnqueueCronHydrate,
} from "./tip-resolve.js"

const revision: WorkspaceRevision = {
  workspaceId: "ws_fixture",
  generation: 1,
  remote: { url: "https://github.com/fixture/context.git", connectionId: null },
  defaultBranch: "main",
  sha: "a".repeat(40),
  access: "read",
}
const ready = { kind: "ready" } as const
const active = (served: WorkspaceRevision): ProjectionState => ({
  kind: "active",
  revision: served,
  stores: { embeddings: ready, graph: ready, index: ready },
})

describe("servedSha", () => {
  it("returns the SHA of a legacy projection", () => {
    expect(
      servedSha(
        {
          kind: "building",
          desired: revision,
          previous: { kind: "legacy", url: null, sha: "b".repeat(40) },
        },
        revision,
      ),
    ).toBe("b".repeat(40))
  })

  it("returns the active SHA for the same binding", () => {
    expect(
      servedSha(active({ ...revision, sha: "c".repeat(40) }), revision),
    ).toBe("c".repeat(40))
  })

  it("returns null when the active binding is different", () => {
    expect(
      servedSha(active({ ...revision, defaultBranch: "trunk" }), revision),
    ).toBeNull()
    expect(
      servedSha(active({ ...revision, generation: 2 }), revision),
    ).toBeNull()
  })

  it("returns null before the first published projection", () => {
    expect(
      servedSha(
        { kind: "building", desired: revision, previous: null },
        revision,
      ),
    ).toBeNull()
  })
})

describe("failedPhaseRetryDue", () => {
  it("is due 1, 2, 4, 8 and 16 hours after the failure hour, then each 24 hours", () => {
    const failedAt = "2026-10-01T10:45:00.000Z"
    const due = Array.from({ length: 70 }, (_, hours) => hours).filter(
      (hours) =>
        failedPhaseRetryDue(
          failedAt,
          new Date(Date.parse("2026-10-01T10:00:00.000Z") + hours * 3_600_000)
            .toISOString()
            .slice(0, 13),
        ),
    )
    expect(due).toEqual([1, 2, 4, 8, 16, 40, 64])
  })

  it("is due in each check when no failure time is stored", () => {
    expect(failedPhaseRetryDue(undefined, "2026-10-01T10")).toBe(true)
  })
})

describe("shouldEnqueueCronHydrate", () => {
  const failed = { kind: "failed", message: "Socket closed" } as const
  const withGraph = (graph: typeof failed | typeof ready): ProjectionState => ({
    kind: "active",
    revision,
    stores: { embeddings: ready, graph, index: ready },
  })
  const retry = (hour: string) => ({
    hour,
    failedAt: { graph: "2026-10-01T10:45:00.000Z" },
  })

  it("builds a failed graph again only when its retry is due", () => {
    const projection = withGraph(failed)
    expect(
      shouldEnqueueCronHydrate({ projection, retry: retry("2026-10-01T12") }),
    ).toBe(true)
    expect(
      shouldEnqueueCronHydrate({ projection, retry: retry("2026-10-01T13") }),
    ).toBe(false)
    expect(shouldEnqueueCronHydrate({ projection })).toBe(true)
  })

  it("does nothing when each phase is ready", () => {
    expect(
      shouldEnqueueCronHydrate({
        projection: withGraph(ready),
        retry: retry("2026-10-01T12"),
      }),
    ).toBe(false)
  })
})
