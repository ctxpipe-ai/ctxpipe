import type { Pool } from "pg"
import { describe, expect, it } from "vitest"
import { APP_ROLE_NAME, provisionAppRole } from "./provision-app-role.js"

type RoleAttrs = {
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreatedb: boolean
  rolcreaterole: boolean
  rolreplication: boolean
  rolcanlogin: boolean
}

function createFakePool(options?: {
  roleExists?: boolean
  roleAttrs?: RoleAttrs
  ownedRelation?: string
  ownedSchema?: string
  membership?: string
  namespaces?: string[]
}) {
  const queries: Array<{ sql: string; params?: unknown[] }> = []
  const roleAttrs: RoleAttrs = options?.roleAttrs ?? {
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolcanlogin: true,
  }
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (sql.includes("SELECT 1 FROM pg_catalog.pg_roles")) {
        return { rowCount: options?.roleExists ? 1 : 0, rows: [] }
      }
      if (sql.includes("format('ALTER ROLE")) {
        return {
          rows: [
            {
              sql: `ALTER ROLE "${APP_ROLE_NAME}" WITH LOGIN PASSWORD 'quoted'`,
            },
          ],
        }
      }
      if (sql.includes("rolbypassrls")) {
        return { rows: [roleAttrs] }
      }
      if (sql.includes("pg_auth_members")) {
        return {
          rows: options?.membership ? [{ n: options.membership }] : [],
        }
      }
      if (sql.includes("nspowner")) {
        return {
          rows: options?.ownedSchema ? [{ n: options.ownedSchema }] : [],
        }
      }
      if (sql.includes("pg_class")) {
        return {
          rows: options?.ownedRelation ? [{ n: options.ownedRelation }] : [],
        }
      }
      if (sql.includes("current_database")) {
        return { rows: [{ current_database: "ctxpipe" }] }
      }
      if (sql.includes("pg_namespace")) {
        return {
          rows: (
            options?.namespaces ?? [
              "public",
              "drizzle",
              "pg_catalog",
              "information_schema",
            ]
          ).map((nspname) => ({ nspname })),
        }
      }
      return { rowCount: 0, rows: [] }
    },
    release: () => undefined,
  }
  return {
    queries,
    pool: { connect: async () => client } as unknown as Pool,
  }
}

describe("provisionAppRole", () => {
  it("creates the app role, quotes the password via format(), and grants public DML", async () => {
    const { pool, queries } = createFakePool()

    await provisionAppRole(pool, "s3cret")

    const sql = queries.map((q) => q.sql).join("\n")
    expect(sql).toContain(`CREATE ROLE "${APP_ROLE_NAME}" LOGIN`)
    expect(sql).toContain("NOBYPASSRLS")
    expect(sql).toContain(
      "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L'",
    )
    expect(sql).toContain(
      `GRANT CONNECT ON DATABASE "ctxpipe" TO "${APP_ROLE_NAME}"`,
    )
    expect(sql).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "${APP_ROLE_NAME}"`,
    )
    expect(sql).toContain(`ALTER DEFAULT PRIVILEGES IN SCHEMA "public"`)
    expect(sql).not.toContain('IN SCHEMA "drizzle"')
    expect(sql).not.toContain('ON SCHEMA "drizzle"')
    expect(sql).not.toContain("PASSWORD $1")
    expect(sql).not.toContain("s3cret")
    expect(
      queries.some(
        (q) =>
          q.sql.includes("format('ALTER ROLE %I WITH LOGIN PASSWORD %L'") &&
          q.params?.[1] === "s3cret",
      ),
    ).toBe(true)
  })

  it("fails closed when an existing app role has BYPASSRLS", async () => {
    const { pool, queries } = createFakePool({
      roleExists: true,
      roleAttrs: {
        rolsuper: false,
        rolbypassrls: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolcanlogin: true,
      },
    })
    await expect(provisionAppRole(pool, "pw")).rejects.toThrow(
      /elevated attributes/,
    )
    expect(queries.some((q) => q.sql.includes("format('ALTER ROLE"))).toBe(
      false,
    )
  })

  it("fails closed when the app role owns a relation", async () => {
    const { pool, queries } = createFakePool({
      roleExists: true,
      ownedRelation: "workspaces",
    })
    await expect(provisionAppRole(pool, "pw")).rejects.toThrow(/owns relation/)
    expect(queries.some((q) => q.sql.includes("format('ALTER ROLE"))).toBe(
      false,
    )
  })

  it("fails closed when the app role is a member of another role", async () => {
    const { pool } = createFakePool({
      roleExists: true,
      membership: "rds_superuser",
    })
    await expect(provisionAppRole(pool, "pw")).rejects.toThrow(/member of/)
  })

  it("rejects unsafe role names instead of interpolating them", async () => {
    const { pool } = createFakePool()
    await expect(
      provisionAppRole(pool, "pw", 'bad"; DROP ROLE x; --'),
    ).rejects.toThrow(/unsafe SQL identifier/)
  })
})
