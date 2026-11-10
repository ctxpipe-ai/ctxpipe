import { rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import {
  clientToolsDirectory,
  type PostgresPair,
  sql,
  startPostgresPair,
} from "../test/postgres-pair.js"
import { fillSyntheticRows } from "../test/synthetic-rows.js"
import { copyDatabase, verifyDatabaseCopy } from "./copy-database.js"
import { runMigrations } from "./run-migrations.js"

/*
 * The cutover copy between two Postgres 17 servers in containers, with the
 * role models of Neon (source) and Aurora (target). The source has the
 * production schema from migrate, synthetic rows in every table, and a
 * fixture table with each column type that the checksum must handle.
 * `pg_dump` and `pg_restore` come from the server image.
 */

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
// Under the repository: a Docker VM (Colima) shares the home directory only.
const workRoot = fileURLToPath(
  new URL(`../../node_modules/.cache/copy-database-${suffix}`, import.meta.url),
)
let pair: PostgresPair
let targetUrl: string

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

describe("copy-database (two Postgres 17 containers)", () => {
  beforeAll(async () => {
    const bin = await clientToolsDirectory(workRoot)
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`)
    pair = await startPostgresPair(["ctxpipe", "ctxpipe_rehearsal"])
    targetUrl = pair.targetUrl("ctxpipe")

    await runMigrations({
      connectionString: pair.sourceUrl,
      appRolePassword: "app-password",
    })
    const filled = await fillSyntheticRows(pair.sourceSuperUrl, {}, 30)
    expect(filled.filter((table) => table.error)).toEqual([])
    // Production is in the state of its last migrate: the backfills and the
    // directory reconcile have run on its rows.
    await runMigrations({
      connectionString: pair.sourceUrl,
      appRolePassword: undefined,
    })
    await sql(
      pair.sourceUrl,
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
      `DELETE FROM openworkflow.workflow_runs`,
      `INSERT INTO openworkflow.workflow_runs
         (namespace_id, id, workflow_name, status, config, attempts, created_at, updated_at)
       VALUES ('default', 'run-open', 'fixture', 'pending', '{}', 0, now(), now()),
              ('default', 'run-done', 'fixture', 'completed', '{}', 1, now(), now())`,
    )
  }, 300_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await pair?.stop()
    await rm(workRoot, { recursive: true, force: true })
  })

  it("copies every table, sequence and object, owned by the target login", async () => {
    const report = await copyDatabase({
      sourceUrl: pair.sourceUrl,
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
    expect(
      report.verify.tables.find((table) => table.table === "public.workspaces"),
    ).toMatchObject({ sourceRows: "30", targetRows: "30", match: true })
    expect(
      report.verify.tables.find(
        (table) => table.table === "cutover_fixture.samples",
      ),
    ).toMatchObject({ sourceRows: "2000", targetRows: "2000", match: true })
    expect(
      report.verify.sequences.find(
        (sequence) => sequence.sequence === "cutover_fixture.samples_id_seq",
      ),
    ).toMatchObject({ source: "2000", target: "2000" })

    // No Neon role came with the copy: the master login owns every object,
    // and `ctxpipe_app` does not exist until migrate makes it.
    expect(
      await rows(
        targetUrl,
        `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'openworkflow', 'drizzle', 'cutover_fixture')`,
      ),
    ).toEqual([{ owner: "ctxpipe" }])
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
    const verify = await verifyDatabaseCopy(pair.sourceUrl, targetUrl)
    expect(verify.problems).toEqual([])
  }, 300_000)

  it("refuses a target that is not empty", async () => {
    await expect(
      copyDatabase({
        sourceUrl: pair.sourceUrl,
        targetUrl,
        workDir: join(workRoot, "again"),
        jobs: 2,
      }),
    ).rejects.toThrow(/Restore only into an empty database/)
  }, 120_000)

  it("cancels the open runs of a rehearsal copy and finds a changed row", async () => {
    const rehearsalUrl = pair.targetUrl("ctxpipe_rehearsal")
    const report = await copyDatabase({
      sourceUrl: pair.sourceUrl,
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
    const verify = await verifyDatabaseCopy(pair.sourceUrl, rehearsalUrl)
    expect(verify.ok).toBe(false)
    expect(verify.problems).toContain(
      "The rows of cutover_fixture.samples differ (same count 2000, other checksum).",
    )
  }, 300_000)
})
