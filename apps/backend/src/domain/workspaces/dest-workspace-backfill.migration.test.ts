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
  it("inserts workspaces and links without starting jobs", () => {
    expect(migrationSql).not.toMatch(/workflow_runs/i)
    expect(migrationSql).not.toMatch(/runWorkflow/i)
    expect(migrationSql).not.toMatch(/INSERT INTO openworkflow/i)
    expect(migrationSql).toContain('INSERT INTO "workspaces"')
    expect(migrationSql).toContain(
      'INSERT INTO "workspace_linked_repositories"',
    )
    expect(migrationSql).toContain("ON CONFLICT ON CONSTRAINT")
    expect(migrationSql).toContain("linear")
    expect(migrationSql).toContain("notion")
    expect(migrationSql).toContain("slack")
    expect(migrationSql).toContain('DROP TABLE "org_workspace_cutover"')
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
