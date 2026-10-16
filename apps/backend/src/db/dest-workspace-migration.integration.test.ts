import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const migrationsDir = join(__dirname, "../../migrations")
const backfill = "20261016064110_workspaces"
const database = `ctxpipe_test_dest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let admin: pg.Client
let db: pg.Client

async function apply(names: string[]) {
  for (const name of names) {
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8")
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.query(statement)
    }
  }
}

describe("dest Workspace SQL migration (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}"`)
    ownerUrl.pathname = `/${database}`
    db = new pg.Client({ connectionString: ownerUrl.toString() })
    await db.connect()
  }, 60_000)

  afterAll(async () => {
    await db?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin?.end()
  })

  it("records the first target Workspace and links no repository in SQL", async () => {
    await apply(migrations.filter((name) => name < backfill))
    const orgId = "org_dest_migration"
    await db.query(
      `INSERT INTO "organizations" ("id", "name", "slug", "created_at") VALUES ($1, 'Acme', 'acme-dest', now())`,
      [orgId],
    )
    await db.query(
      `INSERT INTO "repositories" ("id", "org_id", "name", "git_url", "created_at") VALUES
        ('repo_docs', $1, 'docs', 'https://github.com/acme/docs.git', '2026-01-01T00:00:00Z'),
        ('repo_wiki', $1, 'wiki', 'https://github.com/acme/wiki', '2026-02-01T00:00:00Z'),
        ('repo_app', $1, 'app', 'git@github.com:acme/app.git', '2026-03-01T00:00:00Z')`,
      [orgId],
    )
    await db.query(
      `INSERT INTO "connections" ("id", "org_id", "type", "config") VALUES
        ('con_linear', $1, 'linear', '{"enabled": true, "repositoryId": "repo_wiki"}'),
        ('con_notion', $1, 'notion', '{"enabled": true, "repositoryId": "repo_docs"}')`,
      [orgId],
    )
    await apply(migrations.filter((name) => name >= backfill))

    const { rows: workspaces } = await db.query<{
      id: string
      url: string
    }>(
      `SELECT "id", "workspace_repository_url" AS url FROM "workspaces" WHERE "org_id" = $1`,
      [orgId],
    )
    const workspaceByUrl = new Map(workspaces.map((row) => [row.url, row.id]))
    const docs = workspaceByUrl.get("https://github.com/acme/docs")
    expect(docs).toBeDefined()
    expect(workspaceByUrl.get("https://github.com/acme/wiki")).toBeDefined()

    const { rows: first } = await db.query(
      `SELECT "org_id" AS "orgId", "workspace_id" AS "workspaceId", "source_repository_id" AS "sourceRepositoryId" FROM "org_first_workspaces"`,
    )
    expect(first).toEqual([
      { orgId, workspaceId: docs, sourceRepositoryId: "repo_docs" },
    ])

    // The migration links no repository in SQL. The migration export links
    // the other org repositories through `.ctxpipe/sources.yaml` of the first
    // Workspace, and the sources projection pins them (ADR-050).
    const { rows: links } = await db.query(
      `SELECT "workspace_id" AS "workspaceId" FROM "workspace_sources" WHERE "org_id" = $1`,
      [orgId],
    )
    expect(links).toEqual([])
  }, 120_000)
})
