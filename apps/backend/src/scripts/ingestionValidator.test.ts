import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { environmentProblem, main, parseOptions } from "./ingestionValidator.js"

const dir = mkdtempSync(join(tmpdir(), "ingestion-validator-"))
const repos = join(dir, "repos.txt")
writeFileSync(repos, "n8n-io/n8n typescript\n")
const args = ["--org-id", "org_val", "--repos", repos]

describe("main", () => {
  it("refuses production before reading options or connecting", async () => {
    await expect(
      main(args, { RAILWAY_ENVIRONMENT_NAME: "production" }),
    ).rejects.toThrow("the validator refuses the production environment")
    await expect(main([], { NODE_ENV: "production" })).rejects.toThrow(
      /refuses the production environment/,
    )
    await expect(
      main(args, {
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=production",
      }),
    ).rejects.toThrow(/refuses the production environment/)
  })

  it("refuses a Railway environment on the default OpenWorkflow namespace", async () => {
    await expect(
      main(args, { RAILWAY_ENVIRONMENT_NAME: "ingestion-validator" }),
    ).rejects.toThrow(/own OPENWORKFLOW_NAMESPACE_ID/)
    expect(
      environmentProblem({
        RAILWAY_ENVIRONMENT_NAME: "ingestion-validator",
        OPENWORKFLOW_NAMESPACE_ID: "ingestion-validator",
      }),
    ).toBeNull()
    expect(environmentProblem({})).toBeNull()
  })
})

describe("parseOptions", () => {
  it("defaults to index-only, so spending needs --mode full", () => {
    expect(parseOptions(args)).toMatchObject({
      mode: "index-only",
      workspaceId: null,
      concurrency: 1,
      repos: [{ name: "n8n-io/n8n", expectedLanguages: ["typescript"] }],
    })
    expect(() => parseOptions([...args, "--workspace-id", "ws_1"])).toThrow(
      "--workspace-id is only for --mode full",
    )
    expect(() => parseOptions([...args, "--mode", "full"])).toThrow(
      "--mode full needs --workspace-id",
    )
    expect(
      parseOptions([...args, "--mode", "full", "--workspace-id", "ws_1"]),
    ).toMatchObject({ mode: "full", workspaceId: "ws_1" })
    expect(() => parseOptions([...args, "--mode", "everything"])).toThrow()
  })

  it("validates the quality thresholds file", () => {
    const good = join(dir, "good.json")
    writeFileSync(good, JSON.stringify({ minJoinDensity: 0.2 }))
    expect(
      parseOptions([...args, "--quality-thresholds", good]).qualityThresholds,
    ).toEqual({ minJoinDensity: 0.2 })
    const bad = join(dir, "bad.json")
    writeFileSync(bad, JSON.stringify({ minJoinDensity: 2, typo: 1 }))
    expect(() => parseOptions([...args, "--quality-thresholds", bad])).toThrow()
  })
})
