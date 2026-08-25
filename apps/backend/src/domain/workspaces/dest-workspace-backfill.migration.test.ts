import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const migrationSql = readFileSync(
  join(
    backendRoot,
    "migrations/20260820070625_purple_eddie_brock/migration.sql",
  ),
  "utf8",
)

describe("dest workspace SQL backfill", () => {
  it("inserts workspaces without starting jobs; cardinality is corrected in TypeScript", () => {
    expect(migrationSql).not.toMatch(/workflow_runs/i)
    expect(migrationSql).not.toMatch(/runWorkflow/i)
    expect(migrationSql).not.toMatch(/INSERT INTO openworkflow/i)
    expect(migrationSql).toContain('INSERT INTO "workspaces"')
    expect(migrationSql).toContain("linear")
    expect(migrationSql).toContain("notion")
    expect(migrationSql).toContain("slack")
    expect(migrationSql).toContain('DROP TABLE "org_workspace_cutover"')
  })

  it("keeps the exact-row assignment fixture next to the applied SQL", async () => {
    const { planDestWorkspaceLinks } = await import(
      "./dest-workspace-assignment.js"
    )
    const at = (iso: string) => new Date(iso)
    const plan = planDestWorkspaceLinks({
      workspaces: [
        { id: "ws_docs", workspaceRepositoryUrl: "https://github.com/acme/docs" },
        { id: "ws_wiki", workspaceRepositoryUrl: "https://github.com/acme/wiki" },
      ],
      repositories: [
        {
          id: "repo_first",
          gitUrl: "https://github.com/acme/docs",
          createdAt: at("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "repo_second",
          gitUrl: "https://github.com/acme/wiki",
          createdAt: at("2026-02-01T00:00:00.000Z"),
        },
        {
          id: "repo_app",
          gitUrl: "https://github.com/acme/app",
          createdAt: at("2026-03-01T00:00:00.000Z"),
        },
      ],
      connectorTargetRepositoryIds: ["repo_first", "repo_second"],
      existingLinks: [
        {
          id: "wlr_cross",
          workspaceId: "ws_wiki",
          gitUrl: "https://github.com/acme/app",
        },
      ],
    })
    expect(plan).toEqual({
      firstWorkspaceId: "ws_docs",
      firstSourceRepositoryId: "repo_first",
      insertLinks: [{ workspaceId: "ws_docs", gitUrl: "https://github.com/acme/app" }],
      deleteLinkIds: ["wlr_cross"],
    })
  })

  it("removes the runtime cutover job", () => {
    expect(
      existsSync(
        join(backendRoot, "src/openworkflow/workflows/workspace-cutover.ts"),
      ),
    ).toBe(false)
    expect(
      existsSync(
        join(backendRoot, "src/openworkflow/enqueue-workspace-cutover.ts"),
      ),
    ).toBe(false)
  })
})
