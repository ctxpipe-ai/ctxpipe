import { execFileSync } from "node:child_process"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { parse } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { fileOwnership } from "../ingestion/patch-validator.js"
import { workspaceFormatFile } from "./workspace-format.js"

const BILLING_SOURCE = "sources/github/acme/billing.md"

const humanSection =
  "<!-- ctxpipe:human -->\nA note that a human wrote.\n<!-- /ctxpipe:human -->\n"

const files = [
  {
    // An old extracted file from before the migration export.
    path: "knowledge/services/billing.md",
    body: `---\nimport_key: repo_1:service:billing\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing.git#src/index.ts\n---\n\n# Billing\n\nExtracted text.\n\n${humanSection}`,
  },
  {
    // An old extracted file after the import-key cleanup.
    path: "knowledge/libraries/zod.md",
    body: "---\nkind: Library\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing.git#package.json\n---\n\n# Zod\n",
  },
  {
    // A human took this file over: they removed `generated_by`.
    path: "knowledge/services/ledger.md",
    body: "---\nkind: Service\nsource: https://github.com/acme/billing.git#ledger.ts\n---\n\n# Ledger\n\nA human rewrote this file.\n",
  },
  {
    path: "knowledge/notes.md",
    body: "# Notes\n\nA human file with no front matter.\n",
  },
  {
    // The source file of the repository: its path goes into `sources`
    // (ADR-050 revision 2026-10-16). The fixture puts in the connection id.
    path: BILLING_SOURCE,
    body: '---\nprovider: github\nconnection: "{{connectionId}}"\nrepository: acme/billing\n---\n',
  },
]

/** The format file of the tree; the migration publishes only at 3 or more. */
const formatFile = (format: number) => {
  const file = workspaceFormatFile(format)
  return { path: file.path, body: file.content }
}

/** The `format_version` cache that hydrate writes; admission reads it. */
function cacheFormat(f: NativeHydrationFixture, format: number) {
  return withOrgDbContext(f.org.id, (db) =>
    db
      .update(workspaces)
      .set({ formatVersion: format })
      .where(eq(workspaces.id, f.workspaceId)),
  )
}

function enqueueMigration(f: NativeHydrationFixture, jobId: string) {
  return withOrgIdContext(f.org, () =>
    enqueueWriteJob(
      {
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        jobId,
        kind: "ownership_migration",
      },
      { error: () => {} },
    ),
  )
}

/** Run the migration workflow on the fixture until the job is done. */
async function runMigration(
  f: NativeHydrationFixture,
  jobId: string,
  expectStarted = true,
) {
  const { BackendPostgres } = await import("openworkflow/postgres")
  const { OpenWorkflow } = await import("openworkflow")
  const { workspaceOwnershipMigration } = await import(
    "../../openworkflow/workflows/workspace-ownership-migration.js"
  )
  const backend = await BackendPostgres.connect(f.databaseUrl, {
    namespaceId: openWorkflowNamespaceId(),
    runMigrations: false,
  })
  const runner = new OpenWorkflow({ backend })
  runner.implementWorkflow(
    workspaceOwnershipMigration.spec,
    workspaceOwnershipMigration.fn,
  )
  const worker = runner.newWorker({ concurrency: 1 })
  await worker.start()
  try {
    expect(await enqueueMigration(f, jobId)).toEqual({
      started: expectStarted,
    })
    if (!expectStarted) return null
    await expect
      .poll(
        () =>
          withOrgIdContext(
            f.org,
            async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
          ),
        { timeout: 30_000 },
      )
      .toBe("completed")
    return withOrgIdContext(f.org, () => reconcileWorkspaceWriteJob(jobId))
  } finally {
    await worker.stop()
    await backend.stop()
  }
}

const mainSha = (f: NativeHydrationFixture) =>
  f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main")

it(
  "moves only the old extracted files to ingestion v2 ownership, in one commit",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [...files, formatFile(3)],
      },
      async (f) => {
        const show = (path: string) =>
          execFileSync(
            "git",
            ["--git-dir", f.remote, "show", `refs/heads/main:${path}`],
            { encoding: "utf8" },
          )
        await cacheFormat(f, 3)
        await runMigration(f, `wjob_${f.id}_ownership`)

        expect(
          f.git(
            "--git-dir",
            f.remote,
            "rev-list",
            "--count",
            `${f.sha}..refs/heads/main`,
          ),
        ).toBe("1")
        expect(
          f
            .git(
              "--git-dir",
              f.remote,
              "diff",
              "--name-only",
              f.sha,
              "refs/heads/main",
            )
            .split("\n")
            .sort(),
        ).toEqual([
          "knowledge/libraries/zod.md",
          "knowledge/services/billing.md",
        ])

        const billing = show("knowledge/services/billing.md")
        expect(parse(billing.split("---")[1] ?? "")).toEqual({
          kind: "Service",
          name: "Billing",
          generated_by: "ctxpipe-extract",
          sources: [BILLING_SOURCE],
        })
        expect(
          billing.endsWith(
            `---\n\n# Billing\n\nExtracted text.\n\n${humanSection}`,
          ),
        ).toBe(true)
        expect(fileOwnership(billing, BILLING_SOURCE)).toBe("sole")
        expect(
          fileOwnership(show("knowledge/libraries/zod.md"), BILLING_SOURCE),
        ).toBe("sole")
        for (const file of files.slice(2, 4))
          expect(show(file.path)).toBe(file.body)
      },
    )
  },
)

it(
  "makes no commit when no old extracted file is left",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [...files.slice(2), formatFile(3)],
      },
      async (f) => {
        await cacheFormat(f, 3)
        await runMigration(f, `wjob_${f.id}_ownership_noop`)
        expect(mainSha(f)).toBe(f.sha)
      },
    )
  },
)

it(
  "refuses the migration at admission below format 3, where upgrade step 3 does it",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [...files, formatFile(2)],
      },
      async (f) => {
        await cacheFormat(f, 2)
        await runMigration(f, `wjob_${f.id}_ownership_below`, false)
        expect(mainSha(f)).toBe(f.sha)
      },
    )
  },
)

it(
  "stops at the push when the tree is below format 3 and the cache is stale",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        // A revert of the upgrade pull request: hydrate did not cache it yet.
        files: [...files, formatFile(2)],
      },
      async (f) => {
        await cacheFormat(f, 3)
        expect(
          await runMigration(f, `wjob_${f.id}_ownership_reverted`),
        ).toMatchObject({ status: "completed", commitSha: null })
        expect(mainSha(f)).toBe(f.sha)
      },
    )
  },
)
