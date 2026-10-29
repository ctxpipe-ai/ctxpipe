import { describe, expect, it } from "vitest"

import type { RootExec } from "./ingest-root.js"
import { runIngestShardStep } from "./ingest-shard-ops.js"

/*
 * The scan gate of a model step (CTX-1083). The host runs the `dependencies`
 * scan first, and runs the model only when the scan says that a claim is
 * possible. The sandbox is the environment here: a root command that records
 * what the host runs and answers the scan with a chosen result.
 */

function sandbox(scan: { exitCode: number; stdout: string }) {
  const commands: string[] = []
  const root: RootExec = async (script) => {
    commands.push(script)
    const isScan = script.includes("dependencies/scripts/scan.mjs")
    return {
      exitCode: isScan ? scan.exitCode : 0,
      stdout: isScan ? scan.stdout : "",
      stderr: "",
    }
  }
  const ran = (text: string) => commands.some((c) => c.includes(text))
  return { root, commands, ran }
}

const step = (skill: string) => ({
  name: `skill:repository:${skill}:ws_test`,
  skill,
  run: "model" as const,
  tier: "medium" as const,
  root: null,
  workspaceId: "ws_test",
  baseCommit: "a".repeat(40),
  rootMap: { roots: [] },
  signal: AbortSignal.timeout(30_000),
})
const input = (skill: string) => ({
  step: step(skill),
  agentEnv: {},
  remote: "/remote.git",
  sourceUrl: "https://github.com/example-org/shop",
  sourcePath: "sources/github/example-org/shop.md",
  model: "ctxpipe/test-model",
})

describe("the scan gate of the dependencies step", () => {
  it("runs no model when the scan says that no claim is possible, and finishes the step", async () => {
    const s = sandbox({ exitCode: 0, stdout: '{"needsModel":false}\n' })
    const result = await runIngestShardStep(s.root, input("dependencies"))
    expect(s.ran("--gate")).toBe(true)
    expect(s.ran("opencode")).toBe(false)
    expect(s.ran("ctxpipe-finish")).toBe(true)
    expect(result).toEqual({})
  })

  it("runs the model when the scan finds work", async () => {
    const s = sandbox({ exitCode: 0, stdout: '{"needsModel":true}\n' })
    await runIngestShardStep(s.root, input("dependencies"))
    expect(s.ran("opencode")).toBe(true)
  })

  it("runs the model when the scan fails or prints text that is not a result", async () => {
    for (const scan of [
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: "not json" },
      { exitCode: 0, stdout: '{"needsModel":"no"}' },
    ]) {
      const s = sandbox(scan)
      await runIngestShardStep(s.root, input("dependencies"))
      expect(s.ran("opencode")).toBe(true)
    }
  })

  it("does not scan for another skill", async () => {
    const s = sandbox({ exitCode: 0, stdout: '{"needsModel":false}\n' })
    await runIngestShardStep(s.root, input("apis"))
    expect(s.ran("scan.mjs")).toBe(false)
    expect(s.ran("opencode")).toBe(true)
  })
})
