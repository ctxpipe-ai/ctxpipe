import { execFile } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { HttpResponse, http } from "msw"
import pg from "pg"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import type { AppEnv } from "../app/env.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { readIngestSkillBundle } from "../domain/ingestion/skill-bundle.js"
import { reingestUpgradeKey } from "../domain/upgrades/reingest.js"
import { WORKSPACE_FORMAT_PATH } from "../domain/workspaces/workspace-format.js"
import { getWorkspaceUpgradeRow } from "../models/workspace-upgrades.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../test/native-hydration-fixture.js"
import { withOrgDbContext } from "./client.js"
import { workspaces, workspaceWriteJobs } from "./schema/workspaces.js"

/*
 * Before the imports: the shared OpenWorkflow client reads DATABASE_URL when
 * a module imports it, so DATABASE_URL names the upgraded database as the app
 * role from the start. The client connects only at its first query.
 */
const urls = vi.hoisted(() => {
  // registerV1Routes loads the conversation graph, which builds its model at import time.
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  const serverUrl = process.env.DATABASE_URL ?? ""
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const database = `ctxpipe_upgrade_from_release_${suffix}`
  const appPassword = process.env.DATABASE_APP_PASSWORD || "ctxpipe"
  if (!serverUrl)
    return {
      serverUrl,
      suffix,
      database,
      appPassword,
      ownerUrl: "",
      appUrl: "",
    }
  const url = new URL(serverUrl)
  url.pathname = `/${database}`
  const ownerUrl = url.toString()
  url.username = "ctxpipe_app"
  url.password = appPassword
  const appUrl = url.toString()
  process.env.DATABASE_URL = appUrl
  return { serverUrl, suffix, database, appPassword, ownerUrl, appUrl }
})

/*
 * The minor upgrade from the previous release, end to end (CTX-748). An
 * operator on the previous release (the CI job pins it) deploys this release and changes nothing else:
 *
 * 1. The migrate command of the previous release makes its schema, and SQL seeds an org
 *    as the previous release kept it: GitHub, a Linear connector that synced to a context
 *    repository, the knowledge of the previous release's code ingestion, and rows with no
 *    `org_id` that the migration must fill.
 * 2. The one migrate entry point of this release runs with no manual step.
 *    A second run changes nothing.
 * 3. The Workspace that the migration made from the connector target shows
 *    its upgrade items. They wait for an admin. The admin starts the format
 *    upgrade through the API; it opens one pull request. After the merge,
 *    hydrate records format 3 with no direct write, and the re-ingestion is
 *    ready.
 * 4. Rollback: the previous release's code reads the upgraded database.
 * 5. Rollback window: the previous release's code adds a connection and deletes one, and the
 *    next migrate brings the webhook directory back in line.
 *
 * Inputs: DATABASE_URL (a role that can CREATE DATABASE and CREATE ROLE),
 * RELEASE_TREE (a checkout of the previous release with its dependencies installed).
 */

const backendDir = fileURLToPath(new URL("../..", import.meta.url))
const { suffix, database, appPassword, ownerUrl, appUrl } = urls

const ORG = { id: "org_release_era", slug: "release-era", name: "Release era" }
const ADMIN_TOKEN = "release-era-admin-session-token"
const GITHUB_CONNECTION = "con_release_github"
const WORKSPACE_REPO = "repo_release_context"
const WORKSPACE_URL = "https://github.com/fixture/hydration-contract"
const PULLS = "https://api.github.com/repos/fixture/hydration-contract/pulls"
const SLACK_TEAM = "T0ROLLBACK"
const LINEAR_WORKSPACE = "5f0c1d2e-aaaa-4bbb-8ccc-000000000001"
const LINEAR_CONFIG = `version: 1
source: linear
workspace:
  id: ${LINEAR_WORKSPACE}
  name: Example Co
scope:
  teams:
    - id: 7a1b2c3d-aaaa-4bbb-8ccc-000000000010
      name: Engineering
      key: ENG
      teamId: 7a1b2c3d-aaaa-4bbb-8ccc-000000000010
      teamKey: ENG
      url: https://linear.app/example/team/ENG
  projects: []
  documents: []
  initiatives: []
`

let admin: pg.Client
const testStart = Date.now()
/** A progress line in the CI log, so that a hang names its phase. */
const phase = (name: string) =>
  process.stderr.write(
    `[upgrade-from-release] +${Math.round((Date.now() - testStart) / 1000)}s ${name}\n`,
  )
let releaseTree = ""

/**
 * Run a command and give its stdout. It does not block the event loop, so a
 * command that hangs fails at its own timeout with its output.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  databaseUrl: string,
): Promise<string> {
  phase(`${command} ${args.join(" ")}`)
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DATABASE_APP_PASSWORD: appPassword,
        },
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(
                `${command} ${args.join(" ")} in ${cwd} failed (${error.code ?? error.signal}):\n${stdout}\n${stderr}`,
              ),
            )
          : resolve(stdout),
    ),
  )
}

async function owner<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: ownerUrl })
  await db.connect()
  try {
    return await fn(db)
  } finally {
    await db.end()
  }
}

/** Run a script with the previous release's code from the previous release checkout, as the previous release runs: as the owner role. */
async function runWithRelease(body: string): Promise<unknown> {
  const script = join(
    releaseTree,
    "apps/backend",
    `.upgrade-release-${suffix}.mts`,
  )
  writeFileSync(
    script,
    `const { initDb, closeDb } = await import("./src/db/client.ts")
initDb(process.env.DATABASE_URL)
${body}
await closeDb()
process.exit(0)
`,
  )
  try {
    const out = await run(
      "pnpm",
      ["exec", "tsx", script],
      join(releaseTree, "apps/backend"),
      ownerUrl,
    )
    return JSON.parse(out.trim().split("\n").at(-1) ?? "null")
  } finally {
    rmSync(script, { force: true })
  }
}

/** Two read paths of the previous release's code: the repository list of the org and its connections. */
function readWithRelease(): Promise<unknown> {
  return runWithRelease(`const { listRepositoriesForOrg } = await import("./src/models/repositories.ts")
const { listOrgConnections } = await import("./src/models/org-connections.ts")
const repositories = await listRepositoriesForOrg(${JSON.stringify(ORG.id)})
const connections = await listOrgConnections(${JSON.stringify(ORG.id)})
process.stdout.write("\\n" + JSON.stringify({ repositories: repositories.map((r) => [r.id, r.name, r.gitUrl, r.githubConnectionId]).sort(), connections: connections.map((c) => [c.id, c.type]).sort() }) + "\\n")`)
}

/**
 * In the rollback window, the previous release's code adds a Slack connection and deletes the
 * Linear connection. The previous release writes `connections` only, not the directory.
 */
function writeWithRelease(): Promise<unknown> {
  return runWithRelease(`const { withOrgDbContext } = await import("./src/db/client.ts")
const { upsertSlackConnectionFromOAuth } = await import("./src/models/slack-connector.ts")
const { deleteLinearConnectionById } = await import("./src/models/linear-connector.ts")
const result = await withOrgDbContext(${JSON.stringify(ORG.id)}, async () => {
  const slack = await upsertSlackConnectionFromOAuth({ orgId: ${JSON.stringify(ORG.id)}, env: { AUTH_SECRET: "rollback-window-secret-at-least-32-chars" }, ownerUserId: "user_release_admin", botToken: "xoxb-rollback-window", teamId: ${JSON.stringify(SLACK_TEAM)} })
  const deleted = await deleteLinearConnectionById(${JSON.stringify(ORG.id)}, "con_release_linear")
  return { slack: slack.id, deleted }
})
process.stdout.write("\\n" + JSON.stringify(result) + "\\n")`)
}

/** The org as the previous release kept it, in the previous release's schema. */
async function seedReleaseOrg(db: pg.Client) {
  const q = (text: string, values: unknown[] = []) => db.query(text, values)
  await q(
    `INSERT INTO organizations (id, name, slug, created_at) VALUES ($1, $2, $3, now())`,
    [ORG.id, ORG.name, ORG.slug],
  )
  await q(
    `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
     VALUES ('user_release_admin', 'Admin', 'admin@example.test', true, now(), now())`,
  )
  await q(
    `INSERT INTO members (id, organization_id, user_id, role, created_at)
     VALUES ('mem_release_admin', $1, 'user_release_admin', 'admin', now())`,
    [ORG.id],
  )
  await q(
    `INSERT INTO sessions (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
     VALUES ('ses_release_admin', now() + interval '1 day', $1, now(), now(), 'user_release_admin', $2)`,
    [ADMIN_TOKEN, ORG.id],
  )
  await q(
    `INSERT INTO connections (id, org_id, type, config, created_at, updated_at) VALUES
      ($1, $2, 'github', $3, now(), now())`,
    [
      GITHUB_CONNECTION,
      ORG.id,
      JSON.stringify({
        installationId: 123456789,
        accountSlug: "fixture",
        ingestAllRepositories: false,
        includeFutureRepos: false,
      }),
    ],
  )
  // the previous release names a GitHub repository by its full name (owner/repo), and a
  // repository that an operator added by URL by the name that they gave.
  await q(
    `INSERT INTO repositories (id, org_id, name, git_url, github_connection_id, index_ready, created_at, updated_at) VALUES
      ($1, $2, 'fixture/hydration-contract', 'https://github.com/fixture/hydration-contract.git', $3, true, '2026-01-01T00:00:00Z', now()),
      ('repo_release_api', $2, 'team-a/api', 'https://github.com/team-a/api.git', $3, true, '2026-02-01T00:00:00Z', now()),
      ('repo_release_tools', $2, 'tools', 'https://gitlab.com/team-c/tools.git', NULL, true, '2026-03-01T00:00:00Z', now())`,
    [WORKSPACE_REPO, ORG.id, GITHUB_CONNECTION],
  )
  // The Linear connector of the previous release synced to the context repository: the migration
  // makes the Workspace from this target.
  await q(
    `INSERT INTO connections (id, org_id, type, config, created_at, updated_at) VALUES
      ('con_release_linear', $1, 'linear', $2, now(), now())`,
    [
      ORG.id,
      JSON.stringify({
        enabled: true,
        status: "installed",
        workspaceId: LINEAR_WORKSPACE,
        workspaceName: "Example Co",
        repositoryId: WORKSPACE_REPO,
        branch: "main",
      }),
    ],
  )
  // The knowledge of the previous release's code ingestion.
  await q(
    `INSERT INTO objects (id, org_id, kind, deduplication_key, payload, created_at, updated_at) VALUES
      ('obj_release_tools', $1, 'Service', 'svc:repo_release_tools:tools', $2, now(), now()),
      ('obj_release_parser', $1, 'Library', 'lib:repo_release_tools:parser', $3, now(), now()),
      ('obj_release_api', $1, 'Service', 'svc:repo_release_api:api', $4, now(), now())`,
    [
      ORG.id,
      JSON.stringify({
        name: "Tools CLI",
        summary: "The release tools.",
        path: "cmd/tools/main.go",
      }),
      JSON.stringify({ name: "Parser", summary: "Reads the manifest." }),
      JSON.stringify({ name: "Public API", summary: "Old pipeline text." }),
    ],
  )
  await q(
    `INSERT INTO claims (id, org_id, subject_id, predicate, object_id, status, first_observed_at, last_observed_at, aggregated_confidence, created_at, updated_at)
     VALUES ('clm_release_uses', $1, 'obj_release_tools', 'USES', 'obj_release_parser', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0.9, now(), now())`,
    [ORG.id],
  )
  // the previous release has no `org_id` on these tables. The migration fills it.
  await q(
    `INSERT INTO claim_evidence (id, claim_id, source_type, source_id, extraction_method, confidence, observed_at, created_at)
     VALUES ('cev_release_uses', 'clm_release_uses', 'repository', 'repo_release_tools', 'code', 0.9, '2026-01-01T00:00:00Z', now())`,
  )
  await q(
    `INSERT INTO repository_checkouts (id, repository_id, ref, commit_sha, checkout_key, created_at, updated_at)
     VALUES ('chk_release_api', 'repo_release_api', 'main', $1, 'default', now(), now())`,
    ["a".repeat(40)],
  )
}

/** The schema, the grants and a hash of every row: what a second migrate must not change. */
async function snapshot(db: pg.Client) {
  const { rows: tables } = await db.query<{ s: string; t: string }>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'drizzle', 'openworkflow')
     ORDER BY 1, 2`,
  )
  const data: Record<string, string> = {}
  for (const { s, t } of tables) {
    const { rows } = await db.query<{ n: number; h: string }>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM "${s}"."${t}" x`,
    )
    data[`${s}.${t}`] = `${rows[0]?.n}:${rows[0]?.h}`
  }
  const schema = await db.query(
    `SELECT md5(string_agg(line, E'\\n' ORDER BY line)) AS h FROM (
       SELECT concat_ws(' ', table_schema, table_name, column_name, data_type, is_nullable, column_default) AS line
         FROM information_schema.columns WHERE table_schema IN ('public', 'drizzle', 'openworkflow')
       UNION ALL SELECT indexdef FROM pg_indexes WHERE schemaname IN ('public', 'drizzle', 'openworkflow')
       UNION ALL SELECT concat_ws(' ', tablename, policyname, qual, with_check) FROM pg_policies
       UNION ALL SELECT concat_ws(' ', tgrelid::regclass::text, tgname) FROM pg_trigger WHERE NOT tgisinternal
       UNION ALL SELECT concat_ws(' ', grantee, table_schema, table_name, privilege_type)
         FROM information_schema.role_table_grants WHERE grantee = 'ctxpipe_app'
     ) lines`,
  )
  return { data, schema: schema.rows[0]?.h as string }
}

beforeAll(async () => {
  const serverUrl = urls.serverUrl
  releaseTree = process.env.RELEASE_TREE ?? ""
  if (!serverUrl || !releaseTree)
    throw new Error(
      "DATABASE_URL (a role that can create a database) and RELEASE_TREE (a checkout of the previous release with its dependencies) are required",
    )
  admin = new pg.Client({ connectionString: serverUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${database}"`)
}, 60_000)

afterAll(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  await admin?.end()
})

it("upgrades a database of the previous release and its Workspace with no manual step, and the previous release still reads the result", async () => {
  // 1. The database of the previous release: the previous release's own migrate command, then the previous release's data.
  await run(
    "pnpm",
    ["exec", "drizzle-kit", "migrate"],
    join(releaseTree, "apps/backend"),
    ownerUrl,
  )
  await owner(seedReleaseOrg)
  const releaseRead = await readWithRelease()
  expect(releaseRead).toMatchObject({
    connections: [
      [GITHUB_CONNECTION, "github"],
      ["con_release_linear", "linear"],
    ],
  })
  const before = await owner(async (db) => ({
    objects: (await db.query(`SELECT id FROM objects ORDER BY id`)).rows,
    claims: (await db.query(`SELECT id FROM claims ORDER BY id`)).rows,
    repositories: (await db.query(`SELECT id FROM repositories ORDER BY id`))
      .rows,
    connections: (await db.query(`SELECT id FROM connections ORDER BY id`))
      .rows,
  }))

  // 2. The one migrate entry point of this release, twice.
  await run("pnpm", ["exec", "tsx", "src/db/migrate.ts"], backendDir, ownerUrl)
  const first = await owner(snapshot)
  await run("pnpm", ["exec", "tsx", "src/db/migrate.ts"], backendDir, ownerUrl)
  expect(await owner(snapshot)).toEqual(first)

  const migrated = await owner(async (db) => ({
    objects: (await db.query(`SELECT id FROM objects ORDER BY id`)).rows,
    claims: (await db.query(`SELECT id FROM claims ORDER BY id`)).rows,
    repositories: (await db.query(`SELECT id FROM repositories ORDER BY id`))
      .rows,
    connections: (await db.query(`SELECT id FROM connections ORDER BY id`))
      .rows,
    evidence: (await db.query(`SELECT id, org_id FROM claim_evidence`)).rows,
    checkouts: (await db.query(`SELECT id, org_id FROM repository_checkouts`))
      .rows,
    directory: (
      await db.query(
        `SELECT connection_id, github_installation_id, linear_workspace_id FROM connection_directory ORDER BY connection_id`,
      )
    ).rows,
    workspaces: (
      await db.query(
        `SELECT id, slug, workspace_repository_url, github_connection_id, write_status, format_version FROM workspaces WHERE org_id = $1`,
        [ORG.id],
      )
    ).rows,
    first: (
      await db.query(
        `SELECT workspace_id, source_repository_id FROM org_first_workspaces WHERE org_id = $1`,
        [ORG.id],
      )
    ).rows,
  }))
  // No data loss, and the rows with no org now have the org of their parent.
  expect(migrated).toMatchObject(before)
  expect(migrated.evidence).toEqual([
    { id: "cev_release_uses", org_id: ORG.id },
  ])
  expect(migrated.checkouts).toEqual([
    { id: "chk_release_api", org_id: ORG.id },
  ])
  expect(migrated.directory).toEqual([
    {
      connection_id: GITHUB_CONNECTION,
      github_installation_id: "123456789",
      linear_workspace_id: null,
    },
    {
      connection_id: "con_release_linear",
      github_installation_id: null,
      linear_workspace_id: LINEAR_WORKSPACE,
    },
  ])
  // The connector target of the previous release is now a Workspace, with no format read yet.
  expect(migrated.workspaces).toEqual([
    {
      id: expect.stringMatching(/^ws_/),
      slug: "fixture-hydration-contract",
      workspace_repository_url: WORKSPACE_URL,
      github_connection_id: GITHUB_CONNECTION,
      write_status: "unknown",
      format_version: null,
    },
  ])
  const workspace = migrated.workspaces[0] as { id: string; slug: string }
  expect(migrated.first).toEqual([
    { workspace_id: workspace.id, source_repository_id: WORKSPACE_REPO },
  ])

  // 3. The new code on the upgraded database, as the app role.
  vi.stubEnv("SANDBOX_PROVIDER", "docker")
  const opened: Array<{ head: string; base: string; body: string }> = []
  let openPulls: unknown[] = []
  await withNativeHydrationFixture(
    {
      adopt: {
        org: ORG,
        workspaceId: workspace.id,
        connectionId: GITHUB_CONNECTION,
        workspaceUrl: WORKSPACE_URL,
      },
      github: true,
      githubWriteView: "writable",
      githubContentFiles: { "linear/config.yaml": LINEAR_CONFIG },
      // The context repository in the previous release's layout: no format file (format 0).
      files: [
        { path: "README.md", body: "# Context\n" },
        { path: "linear/config.yaml", body: LINEAR_CONFIG },
        {
          path: "repositories/api.md",
          body: "---\ngit: https://github.com/team-a/api.git\n---\n",
        },
      ],
      onGithubPullRequest: (body) => {
        const pull = body as (typeof opened)[number]
        opened.push(pull)
        openPulls = [
          {
            number: 7,
            html_url: "https://github.com/fixture/hydration-contract/pull/7",
            head: { ref: pull.head },
            created_at: "2026-10-16T00:00:00Z",
          },
        ]
      },
    },
    async (f) => {
      f.server.use(http.get(PULLS, () => HttpResponse.json(openPulls)))
      const { BackendPostgres } = await import("openworkflow/postgres")
      const { OpenWorkflow } = await import("openworkflow")
      const { workspaceUpgradeScan } = await import(
        "../openworkflow/workflows/workspace-upgrade-scan.js"
      )
      const { workspaceUpgrade } = await import(
        "../openworkflow/workflows/workspace-upgrade.js"
      )
      const { workspaceHydrate } = await import(
        "../openworkflow/workflows/workspace-hydrate.js"
      )
      const { registerV1Routes } = await import("../routes/v1/index.js")
      const backend = await BackendPostgres.connect(appUrl, {
        namespaceId: openWorkflowNamespaceId(),
        runMigrations: false,
      })
      const runner = new OpenWorkflow({ backend })
      runner.implementWorkflow(
        workspaceUpgradeScan.spec,
        workspaceUpgradeScan.fn,
      )
      runner.implementWorkflow(workspaceUpgrade.spec, workspaceUpgrade.fn)
      const worker = runner.newWorker({ concurrency: 1 })
      const reingestKey = reingestUpgradeKey(
        (await readIngestSkillBundle()).name,
      )
      const row = (key: string) =>
        withOrgIdContext(ORG, () => getWorkspaceUpgradeRow(workspace.id, key))
      /** On a timeout, name each run and the steps of the run that did not end. */
      const settle = async <T>(handle: {
        workflowRun: { id: string }
        result: () => Promise<T>
      }): Promise<T> => {
        try {
          return await handle.result()
        } catch (error) {
          const lines: string[] = []
          for (const b of [backend, f.backend])
            for (const r of (await b.listWorkflowRuns({ limit: 200 })).data)
              lines.push(
                `${r.workflowName} ${r.status} attempts=${r.attempts} ${r.error?.message ?? ""}`,
              )
          const steps = await backend
            .listStepAttempts({ workflowRunId: handle.workflowRun.id })
            .catch(() =>
              f.backend.listStepAttempts({
                workflowRunId: handle.workflowRun.id,
              }),
            )
          for (const step of steps.data)
            lines.push(
              `  step ${step.stepName} ${step.status} ${JSON.stringify(step.error)}`,
            )
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${lines.join("\n")}`,
          )
        }
      }
      const scan = async (trigger: string) => {
        const handle = await runner.runWorkflow(workspaceUpgradeScan.spec, {
          orgId: ORG.id,
          release: "test",
          trigger,
        })
        return settle({
          workflowRun: handle.workflowRun,
          result: () => handle.result({ timeoutMs: 90_000 }),
        })
      }
      const api = (method: string, path: string) => {
        const env = parseEnv(process.env)
        const app = new OpenAPIHono<AppEnv>()
        app.use(contextStorage())
        app.use(evlog())
        app.use(withTestRequestLogger)
        app.use("*", async (c, next) => {
          c.set("env", env)
          c.set("user", null)
          c.set("session", null)
          c.set("oauthReferenceId", null)
          c.set("oauthClientId", null)
          c.set("oauthScopes", null)
          c.set("orgApiKey", null)
          c.set("personalApiKeyId", null)
          c.set("orgSlug", null)
          c.set("orgId", null)
          await next()
        })
        registerV1Routes(app)
        // The session that the previous release stored for the admin still signs in.
        return app.request(
          `http://backend.test/${ORG.slug}/api/v1/workspaces/${workspace.slug}${path}`,
          { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
        )
      }
      const branchHead = () =>
        f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main")
      try {
        phase("start workers and the first hydrate")
        await f.worker.start()
        await worker.start()
        // The first hydrate after the deploy reads the layout of the previous release: format 0.
        expect(
          await settle({
            workflowRun: f.handle.workflowRun,
            result: () => f.handle.result({ timeoutMs: 120_000 }),
          }),
        ).toMatchObject({
          hydrated: true,
        })
        expect(branchHead()).toBe(f.sha)

        // The scan records each upgrade item and starts nothing.
        phase("first scan")
        await scan("deploy")
        expect(await row("format-3")).toMatchObject({
          status: "awaiting_operator",
          upgrade: {
            fromFormat: 0,
            targetFormat: 3,
            branch: "ctxpipe/upgrade/format-3",
          },
        })
        // The re-ingestion item shows too, blocked until the format upgrade
        // merges, with the repositories that the upgrade links: the GitHub
        // repository, and the public GitLab repository of the previous release as a plain
        // git source (CTX-815).
        const waiting = await row(reingestKey)
        expect(waiting).toMatchObject({
          status: "blocked",
          upgrade: { blockedReason: "needs_format", fromFormat: 0 },
        })
        expect(
          waiting?.upgrade.estimate?.perRepository.map(
            (entry) => entry.repository,
          ),
        ).toEqual(["gitlab.com/team-c/tools", "team-a/api"])
        expect(opened).toEqual([])
        phase("list upgrades through the API")
        const listed = await api("GET", "/upgrades")
        expect(listed.status).toBe(200)
        const items = ((await listed.json()) as { items: unknown[] }).items
        expect(items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: "format-3",
              status: "awaiting_operator",
            }),
          ]),
        )
        expect(items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: reingestKey,
              status: "blocked",
              blockedReason: "needs_format",
            }),
          ]),
        )

        // Below format 3 no ingestion runs, and MCP still serves the
        // knowledge of the previous release from Postgres.
        phase("search the knowledge of the previous release through MCP")
        const { getAuth } = await import("../auth/config.js")
        const { callTool, connectToolClient } = await import(
          "../test/related-fixture.js"
        )
        const { searchKnowledgeTool } = await import(
          "../mcp/tools/search-knowledge.js"
        )
        const orgKey = await getAuth().api.createApiKey({
          body: {
            configId: "organization",
            name: "upgrade-from-release",
            organizationId: ORG.id,
          },
          headers: new Headers({ authorization: `Bearer ${ADMIN_TOKEN}` }),
        })
        const mcp = await connectToolClient(
          { orgApiKey: orgKey.key },
          searchKnowledgeTool,
        )
        try {
          const found = await callTool(mcp, "search_knowledge", {
            org: ORG.slug,
            workspaces: [workspace.slug],
            query: "release tools",
          })
          expect(found.isError).not.toBe(true)
          expect(found.structuredContent?.hits).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ title: "Tools CLI" }),
            ]),
          )
        } finally {
          await mcp.close()
        }

        // The click of the admin, through the API.
        phase("start the format upgrade through the API")
        const started = await api("POST", "/upgrades/format-3/start")
        expect(started.status).toBe(202)
        await expect
          .poll(async () => (await row("format-3"))?.status, {
            timeout: 120_000,
          })
          .toMatch(/^(pr_open|failed|blocked)$/)
        const ran = await row("format-3")
        expect({
          status: ran?.status,
          failureReason: ran?.failureReason ?? null,
          note: ran?.upgrade.note ?? null,
        }).toEqual({ status: "pr_open", failureReason: null, note: null })
        // One pull request: one commit for each step, then the format file.
        expect(opened).toHaveLength(1)
        expect(opened[0]).toMatchObject({
          head: "ctxpipe/upgrade/format-3",
          base: "main",
        })
        const head = f.git(
          "--git-dir",
          f.remote,
          "rev-parse",
          "refs/heads/ctxpipe/upgrade/format-3",
        )
        expect(
          f
            .git(
              "--git-dir",
              f.remote,
              "log",
              "--format=%s",
              `${f.sha}..${head}`,
            )
            .split("\n"),
        ).toEqual([
          "ctx| upgrade: set the Workspace format to 3",
          "ctx| upgrade to format 3: Ingestion v2 ownership of extracted files",
          "ctx| upgrade to format 2: One file for each source under sources/",
          "ctx| upgrade to format 1: Move the sources and keep the old knowledge",
        ])
        expect(
          f.git(
            "--git-dir",
            f.remote,
            "show",
            `${head}:${WORKSPACE_FORMAT_PATH}`,
          ),
        ).toContain("format: 3")
        // ctx| never pushed to the default branch.
        expect(branchHead()).toBe(f.sha)

        // The pull request merges. Hydrate reads format 3.
        f.git(
          "--git-dir",
          f.remote,
          "update-ref",
          "refs/heads/main",
          head,
          f.sha,
        )
        phase("merge and hydrate")
        const revision = await f.resolveRevision(true)
        expect(revision.sha).toBe(head)
        const hydrate = await f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: ORG.id,
          workspaceId: workspace.id,
          revision,
        })
        expect(
          await settle({
            workflowRun: hydrate.workflowRun,
            result: () => hydrate.result({ timeoutMs: 120_000 }),
          }),
        ).toMatchObject({
          hydrated: true,
        })
        await expect
          .poll(async () => (await row("format-3"))?.status, {
            timeout: 120_000,
          })
          .toBe("completed")
        const [upgraded] = await withOrgDbContext(ORG.id, (db) =>
          db
            .select({ formatVersion: workspaces.formatVersion })
            .from(workspaces)
            .where(eq(workspaces.id, workspace.id)),
        )
        expect(upgraded?.formatVersion).toBe(3)
        // No direct write to the default branch: only the upgrade jobs.
        const jobs = await withOrgDbContext(ORG.id, (db) =>
          db
            .select({ kind: workspaceWriteJobs.kind })
            .from(workspaceWriteJobs)
            .where(eq(workspaceWriteJobs.workspaceId, workspace.id)),
        )
        expect(jobs.map((job) => job.kind)).toEqual(jobs.map(() => "upgrade"))
        expect(branchHead()).toBe(head)

        // The re-ingestion is now ready for the click of an admin.
        phase("scan after the merge")
        await scan("after-merge")
        const sources = await owner(
          async (db) =>
            (
              await db.query(
                `SELECT source_key, provider, status, status_detail, scope FROM workspace_sources WHERE workspace_id = $1 ORDER BY source_key`,
                [workspace.id],
              )
            ).rows,
        )
        expect(await row(reingestKey), JSON.stringify(sources)).toMatchObject({
          status: "awaiting_operator",
          upgrade: { targetFormat: 3 },
        })
        expect(sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source_key: "sources/git/gitlab.com/team-c-tools.md",
              provider: "git",
              status: "ok",
              scope: {
                url: expect.stringMatching(
                  /^https:\/\/gitlab\.com\/team-c\/tools(\.git)?$/,
                ),
              },
            }),
          ]),
        )
        expect(
          (await row(reingestKey))?.upgrade.estimate?.perRepository.map(
            (entry) => entry.repository,
          ),
        ).toEqual(["gitlab.com/team-c/tools", "team-a/api"])
      } finally {
        await worker.stop()
        await backend.stop()
      }
    },
  )

  phase("read with the previous release after the upgrade")
  // 4. Rollback: the code of the previous release reads the upgraded database as it read
  // the database of the previous release.
  expect(await readWithRelease()).toEqual(releaseRead)

  // 5. In the rollback window the previous release adds one connection and deletes one. The
  // next migrate makes the webhook directory agree with `connections` again.
  phase("the previous release writes in the rollback window")
  const written = (await writeWithRelease()) as {
    slack: string
    deleted: boolean
  }
  expect(written.deleted).toBe(true)
  const directory = () =>
    owner(
      async (db) =>
        (
          await db.query(
            `SELECT connection_id, type, slack_team_id FROM connection_directory ORDER BY connection_id`,
          )
        ).rows,
    )
  expect(await directory()).toEqual([
    { connection_id: GITHUB_CONNECTION, type: "github", slack_team_id: null },
    {
      connection_id: "con_release_linear",
      type: "linear",
      slack_team_id: null,
    },
  ])
  await run("pnpm", ["exec", "tsx", "src/db/migrate.ts"], backendDir, ownerUrl)
  expect(await directory()).toEqual(
    [
      { connection_id: GITHUB_CONNECTION, type: "github", slack_team_id: null },
      {
        connection_id: written.slack,
        type: "slack",
        slack_team_id: SLACK_TEAM,
      },
    ].sort((a, b) => a.connection_id.localeCompare(b.connection_id)),
  )
})
