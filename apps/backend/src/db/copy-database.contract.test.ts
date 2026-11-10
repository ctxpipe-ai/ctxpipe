import { execFile } from "node:child_process"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { copyDatabase, verifyDatabaseCopy } from "./copy-database.js"
import { runMigrations } from "./run-migrations.js"

/*
 * The cutover copy between two Postgres 17 servers in containers. The source
 * has the roles of Neon (`neon_superuser`, an owner role `neondb_owner`). The
 * target has the roles of Aurora: a master login that is not a superuser,
 * and an `rds_superuser` group. `pg_dump` and `pg_restore` come from the same
 * image, through small wrappers on PATH.
 */

const exec = promisify(execFile)
const IMAGE =
  "pgvector/pgvector:pg17@sha256:7d0a41464797aeb9862dfdc0bbf1526b82cfd324cdd8036df19e3545f4a9ccb8"
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
// Under the repository: a Docker VM (Colima) shares the home directory only.
const workRoot = fileURLToPath(
  new URL(`../../node_modules/.cache/copy-database-${suffix}`, import.meta.url),
)
const containers: string[] = []
let sourceAdmin: string
let targetAdmin: string
let sourceUrl: string
let targetUrl: string

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

/** Starts a server and returns the URL of its superuser on 127.0.0.1. */
async function startServer(superuser: string): Promise<string> {
  const id = await docker(
    "run",
    "-d",
    "--rm",
    "-e",
    `POSTGRES_USER=${superuser}`,
    "-e",
    "POSTGRES_PASSWORD=admin",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    IMAGE,
  )
  containers.push(id)
  const port = (await docker("port", id, "5432/tcp")).split(":").pop()
  const url = `postgresql://${superuser}:admin@127.0.0.1:${port}/postgres`
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      await client.query("SELECT 1")
      return url
    } catch (error) {
      if (attempt > 120) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    } finally {
      await client.end().catch(() => undefined)
    }
  }
}

async function sql(url: string, ...statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    for (const statement of statements) await client.query(statement)
  } finally {
    await client.end()
  }
}

async function rows<T extends pg.QueryResultRow>(
  url: string,
  statement: string,
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<T>(statement)).rows
  } finally {
    await client.end()
  }
}

function database(url: string, name: string, user: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  parsed.username = user
  parsed.password = "owner-password"
  return parsed.toString()
}

/** `pg_dump` and `pg_restore` of the server image, for the copy to call. */
async function installClientTools(): Promise<void> {
  const bin = join(workRoot, "bin")
  await mkdir(bin, { recursive: true })
  const { stdout: uid } = await exec("id", ["-u"])
  const { stdout: gid } = await exec("id", ["-g"])
  for (const tool of ["pg_dump", "pg_restore"]) {
    const path = join(bin, tool)
    await writeFile(
      path,
      [
        "#!/bin/sh",
        `exec docker run --rm --network host --user ${uid.trim()}:${gid.trim()} -e PGPASSWORD -v "${workRoot}:${workRoot}" ${IMAGE} ${tool} "$@"`,
        "",
      ].join("\n"),
    )
    await chmod(path, 0o755)
  }
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`)
}

describe("copy-database (two Postgres 17 containers)", () => {
  beforeAll(async () => {
    await mkdir(workRoot, { recursive: true })
    await installClientTools()
    ;[sourceAdmin, targetAdmin] = await Promise.all([
      startServer("cloud_admin"),
      startServer("rdsadmin"),
    ])

    // Neon: the owner role is a member of neon_superuser, which has BYPASSRLS.
    await sql(
      sourceAdmin,
      "CREATE ROLE neon_superuser NOLOGIN BYPASSRLS CREATEDB CREATEROLE",
      "CREATE ROLE neondb_owner LOGIN PASSWORD 'owner-password' CREATEDB CREATEROLE IN ROLE neon_superuser",
      "CREATE DATABASE neondb OWNER neondb_owner",
    )
    sourceUrl = database(sourceAdmin, "neondb", "neondb_owner")
    await sql(
      database(sourceAdmin, "neondb", "cloud_admin").replace(
        "owner-password",
        "admin",
      ),
      "CREATE EXTENSION vector",
    )
    // Aurora: the master login is not a superuser. It can make the allowed
    // extensions; here a superuser makes vector, which is not trusted.
    await sql(
      targetAdmin,
      "CREATE ROLE rds_superuser NOLOGIN",
      "CREATE ROLE ctxpipe LOGIN PASSWORD 'owner-password' CREATEDB CREATEROLE IN ROLE rds_superuser",
      "CREATE DATABASE ctxpipe OWNER ctxpipe",
      "CREATE DATABASE ctxpipe_rehearsal OWNER ctxpipe",
    )
    for (const name of ["ctxpipe", "ctxpipe_rehearsal"])
      await sql(
        database(targetAdmin, name, "rdsadmin").replace(
          "owner-password",
          "admin",
        ),
        "CREATE EXTENSION vector",
      )
    targetUrl = database(targetAdmin, "ctxpipe", "ctxpipe")

    // The source has the production schema, made by migrate as the owner.
    await runMigrations({
      connectionString: sourceUrl,
      appRolePassword: "app-password",
    })
    await sql(
      sourceUrl,
      `CREATE SCHEMA cutover_fixture`,
      `CREATE TABLE cutover_fixture.samples (
         id serial PRIMARY KEY, label text, payload jsonb, at timestamptz,
         ratio float8, amount numeric, blob bytea, tags text[],
         embedding vector(3), missing text)`,
      `INSERT INTO cutover_fixture.samples (label, payload, at, ratio, amount, blob, tags, embedding)
       SELECT 'row ' || i, jsonb_build_object('i', i, 'even', i % 2 = 0),
              timestamptz '2026-01-01 00:00:00+00' + i * interval '37 minutes',
              i / 7.0, i * 1.25, decode(md5(i::text), 'hex'), ARRAY['a' || i, 'b'],
              ('[' || i || ',' || i / 3.0 || ',0.5]')::vector
       FROM generate_series(1, 2000) AS i`,
      `INSERT INTO openworkflow.workflow_runs
         (namespace_id, id, workflow_name, status, config, attempts, created_at, updated_at)
       VALUES ('default', 'run-open', 'fixture', 'pending', '{}', 0, now(), now()),
              ('default', 'run-done', 'fixture', 'completed', '{}', 1, now(), now())`,
    )
  }, 300_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await Promise.all(
      containers.map((id) => docker("rm", "-f", id).catch(() => undefined)),
    )
    await rm(workRoot, { recursive: true, force: true })
  })

  it("copies every table, sequence and object, owned by the target login", async () => {
    const report = await copyDatabase({
      sourceUrl,
      targetUrl,
      workDir: join(workRoot, "copy"),
      jobs: 4,
    })

    expect(report.verify.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.phases.map((phase) => phase.name)).toEqual([
      "preflight",
      "dump",
      "restore",
      "verify",
    ])
    expect(report.preflight.extensions).toContainEqual(
      expect.objectContaining({ name: "vector" }),
    )
    const samples = report.verify.tables.find(
      (table) => table.table === "cutover_fixture.samples",
    )
    expect(samples).toMatchObject({
      sourceRows: "2000",
      targetRows: "2000",
      match: true,
    })
    expect(
      report.verify.sequences.find(
        (sequence) => sequence.sequence === "cutover_fixture.samples_id_seq",
      ),
    ).toMatchObject({ source: "2000", target: "2000" })

    // No Neon role came with the copy: the master login owns every object,
    // and `ctxpipe_app` does not exist until migrate makes it.
    const owners = await rows<{ owner: string }>(
      targetUrl,
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'openworkflow', 'drizzle', 'cutover_fixture')`,
    )
    expect(owners).toEqual([{ owner: "ctxpipe" }])
    expect(
      await rows(
        targetUrl,
        "SELECT 1 FROM pg_roles WHERE rolname = 'ctxpipe_app'",
      ),
    ).toEqual([])
  }, 300_000)

  it("lets migrate make the app role on the copy without a change to a row", async () => {
    await runMigrations({
      connectionString: targetUrl,
      appRolePassword: "new-aurora-app-password",
    })

    const [role] = await rows<{ rolbypassrls: boolean; groups: string }>(
      targetUrl,
      `SELECT rolbypassrls, (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::text AS groups
       FROM pg_roles r WHERE rolname = 'ctxpipe_app'`,
    )
    expect(role).toEqual({ rolbypassrls: false, groups: "0" })
    const verify = await verifyDatabaseCopy(sourceUrl, targetUrl)
    expect(verify.problems).toEqual([])
  }, 300_000)

  it("refuses a target that is not empty", async () => {
    await expect(
      copyDatabase({
        sourceUrl,
        targetUrl,
        workDir: join(workRoot, "again"),
        jobs: 2,
      }),
    ).rejects.toThrow(/Restore only into an empty database/)
  }, 120_000)

  it("cancels the open runs of a rehearsal copy and finds a changed row", async () => {
    const rehearsalUrl = database(targetAdmin, "ctxpipe_rehearsal", "ctxpipe")
    const report = await copyDatabase({
      sourceUrl,
      targetUrl: rehearsalUrl,
      workDir: join(workRoot, "rehearsal"),
      jobs: 2,
      cancelOpenRuns: true,
    })
    expect(report.ok).toBe(true)
    expect(report.canceledRuns).toBe(1)
    expect(
      await rows(
        rehearsalUrl,
        "SELECT id, status FROM openworkflow.workflow_runs ORDER BY id",
      ),
    ).toEqual([
      { id: "run-done", status: "completed" },
      { id: "run-open", status: "canceled" },
    ])

    await sql(
      rehearsalUrl,
      "UPDATE cutover_fixture.samples SET label = 'changed' WHERE id = 17",
    )
    const verify = await verifyDatabaseCopy(sourceUrl, rehearsalUrl)
    expect(verify.ok).toBe(false)
    expect(verify.problems).toContain(
      "The rows of cutover_fixture.samples differ (same count 2000, other checksum).",
    )
  }, 300_000)
})
