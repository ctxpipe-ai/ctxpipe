import { beforeAll, describe, expect, it } from "vitest"
import { createLogger, withLogger } from "../../observability/logger.js"
import {
  type IngestionShardWorkspace,
  runSkillPages,
} from "./ingestion-shard.js"

/*
 * `runSkillPages` with a step function that returns the step result and runs
 * no sandbox: the partial accounting of a root (concept section 7.3). The
 * module makes an OpenWorkflow client when it loads, so it needs a database.
 */

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for the ingestion shard module")
})

function pages(
  root: string | null,
  results: Array<
    | { partial: true }
    | { tip: string; ops: number; rejects: number; more: boolean }
  >,
) {
  const state: IngestionShardWorkspace = {
    workspaceId: "ws_alpha",
    tip: null,
    ops: 0,
    rejects: 0,
    partial: 0,
    partialRoots: [],
  }
  const run = withLogger(createLogger({ test: "skill-pages" }), () =>
    runSkillPages({
      step: async () => {
        const result = results.shift()
        if (!result) throw new Error("No more step results")
        return result
      },
      root,
      skill: { name: "apis" },
      run: { runId: "run_fixture" },
      destination: { workspaceId: "ws_alpha" },
      state,
    } as unknown as Parameters<typeof runSkillPages>[0]),
  )
  return run.then(() => state)
}

describe("runSkillPages", () => {
  it("records the root of a step that failed", async () => {
    const state = await pages("services/a", [{ partial: true }])
    expect(state).toMatchObject({ partial: 1, partialRoots: ["services/a"] })
  })

  it("records the root of a skill that stops with files left", async () => {
    const state = await pages("services/b", [
      { tip: "a".repeat(40), ops: 0, rejects: 1, more: true },
    ])
    expect(state).toMatchObject({ partial: 1, partialRoots: ["services/b"] })
  })

  it("records no root for a repository-wide step", async () => {
    const state = await pages(null, [{ partial: true }])
    expect(state).toMatchObject({ partial: 1, partialRoots: [] })
  })

  it("records no root for a root whose steps all pass", async () => {
    const state = await pages("services/c", [
      { tip: "a".repeat(40), ops: 1, rejects: 0, more: false },
    ])
    expect(state).toMatchObject({ partial: 0, partialRoots: [] })
  })
})
