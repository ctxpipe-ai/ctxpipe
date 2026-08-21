import type { Pool } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"

const log = { info: vi.fn(), error: vi.fn() }

vi.mock("../observability/logger.js", () => ({ log }))

const { provisionAppRole, APP_ROLE_NAME } = await import(
  "./provision-app-role.js"
)

function createFakePool(queries: Array<{ sql: string; params?: unknown[] }>) {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (sql.includes("pg_roles")) {
        return { rowCount: 0, rows: [] }
      }
      if (sql.includes("current_database")) {
        return { rows: [{ current_database: "ctxpipe" }] }
      }
      if (sql.includes("pg_namespace")) {
        return {
          rows: [
            { nspname: "public" },
            { nspname: "pg_catalog" },
            { nspname: "information_schema" },
          ],
        }
      }
      return { rowCount: 0, rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    pool: { connect: async () => client } as unknown as Pool,
    client,
  }
}

describe("provisionAppRole", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("creates the app role, binds the password, and grants public DML", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const { pool } = createFakePool(queries)

    await provisionAppRole(pool, "s3cret")

    const sql = queries.map((q) => q.sql).join("\n")
    expect(sql).toContain(`CREATE ROLE "${APP_ROLE_NAME}" LOGIN`)
    expect(sql).toContain("NOBYPASSRLS")
    expect(sql).toContain(
      `GRANT CONNECT ON DATABASE "ctxpipe" TO "${APP_ROLE_NAME}"`,
    )
    expect(sql).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "${APP_ROLE_NAME}"`,
    )
    expect(sql).toContain(`ALTER DEFAULT PRIVILEGES IN SCHEMA "public"`)
    expect(sql).not.toContain('IN SCHEMA "pg_catalog"')
    expect(sql).not.toContain('ON SCHEMA "pg_catalog"')
    expect(
      queries.some(
        (q) => q.sql.includes("PASSWORD $1") && q.params?.[0] === "s3cret",
      ),
    ).toBe(true)
    expect(sql).not.toContain("s3cret")
  })

  it("rejects unsafe role names instead of interpolating them", async () => {
    const { pool } = createFakePool([])
    await expect(
      provisionAppRole(pool, "pw", 'bad"; DROP ROLE x; --'),
    ).rejects.toThrow(/unsafe SQL identifier/)
  })
})
