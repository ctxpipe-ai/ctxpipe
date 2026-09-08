import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

try {
  if (Number(process.versions.node.split(".")[0]) !== 22)
    throw new Error("CI requires Node.js 22")
  const version = (binary) => {
    try {
      return execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    } catch {
      throw new Error(
        `Required prerequisite ${binary} is missing or failed --version`,
      )
    }
  }
  process.stdout.write(`${version("git")}\n`)
  process.stdout.write(`${version("ast-grep")}\n`)
  const bun = version("bun")
  const parts = bun.split(".").map(Number)
  if (
    parts.length !== 3 ||
    parts.some(Number.isNaN) ||
    parts[0] !== 1 ||
    parts[1] < 3 ||
    (parts[1] === 3 && parts[2] < 11)
  ) {
    throw new Error(`Bun must satisfy package.json ^1.3.11; found ${bun}`)
  }
  const expected = readFileSync(
    new URL(
      "../../apps/backend/src/domain/workspaces/workspace-chat-opencode-contract.ts",
      import.meta.url,
    ),
    "utf8",
  ).match(/WORKSPACE_CHAT_OPENCODE_CLI = "opencode-ai@([^"]+)"/)?.[1]
  if (!expected) throw new Error("Cannot read the declared OpenCode version")
  const opencode = version("opencode")
  if (opencode !== expected)
    throw new Error(`OpenCode must be ${expected}; found ${opencode}`)
  for (const binary of ["zoekt-index", "zoekt-webserver"]) {
    try {
      execFileSync(binary, ["-h"], { timeout: 10_000, stdio: "ignore" })
    } catch {
      throw new Error(
        `Required native index prerequisite ${binary} is missing or failed -h`,
      )
    }
  }
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL for a migrated application-role test database is required",
    )
  if ((process.env.AUTH_SECRET?.length ?? 0) < 32)
    throw new Error("AUTH_SECRET must contain at least 32 characters")
  const { Pool } = createRequire(
    new URL("../../apps/backend/package.json", import.meta.url),
  )("pg")
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  })
  try {
    const {
      rows: [row],
    } = await pool.query(`
      SELECT current_user AS role, rolsuper, rolbypassrls,
        to_regclass('public.workspaces') AS workspaces,
        to_regclass('public.workspace_sandbox_instances') AS instances,
        to_regclass('public.checkpoints') AS checkpoints,
        to_regclass('openworkflow.workflow_runs') AS workflows,
        EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'openworkflow')
            AND c.relkind IN ('r', 'p') AND pg_has_role(c.relowner, 'USAGE')
        ) AS owns_tables
      FROM pg_roles WHERE rolname = current_user
    `)
    if (!row || row.rolsuper || row.rolbypassrls || row.owns_tables)
      throw new Error(
        "Tests must use an application role without superuser/BYPASSRLS or table ownership",
      )
    if (!row.workspaces || !row.instances || !row.checkpoints || !row.workflows)
      throw new Error(
        "Required workspace, checkpoint and OpenWorkflow migrations have not run",
      )
    process.stdout.write(
      `Prerequisites ready: Bun ${bun}, OpenCode ${opencode}, migrated PostgreSQL role ${row.role}\n`,
    )
  } finally {
    await pool.end()
  }
  if (!process.env.GRAPH_DB_URI)
    throw new Error(
      "GRAPH_DB_URI for the required native FalkorDB proof is required",
    )
  const { FalkorDB } = createRequire(
    new URL("../../apps/backend/package.json", import.meta.url),
  )("falkordb")
  const graphDb = await FalkorDB.connect({
    url: process.env.GRAPH_DB_URI,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  })
  const graph = graphDb.selectGraph(`prerequisite_${process.pid}_${Date.now()}`)
  try {
    const result = await graph.query("RETURN 1 AS ready")
    if (result.data?.[0]?.ready !== 1)
      throw new Error("FalkorDB did not execute the required graph query")
    process.stdout.write("Native FalkorDB graph prerequisite ready\n")
  } finally {
    try {
      await graph.delete()
    } finally {
      await graphDb.close()
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
