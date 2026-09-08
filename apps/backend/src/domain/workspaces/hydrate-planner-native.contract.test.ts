import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { bootstrapWorkspaceFiles } from "./bootstrap.js"

it(
  "hydration durably admits each remaining maintenance concern once",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "knowledge/a.md", body: "# A\n[B](b.md)\n" },
          {
            path: "knowledge/b.md",
            body: "---\nclaims:\n  - to: a.md\n---\n# B\n",
          },
        ],
      },
      async (f) => {
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })

        try {
          await f.publish()
          const jobs = async () =>
            (await backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) =>
                (run.input as { workspaceId?: string }).workspaceId ===
                  f.workspaceId &&
                run.workflowName.startsWith("workspace-write-"),
            )
          expect((await jobs()).map((run) => run.workflowName).sort()).toEqual([
            "workspace-write-bootstrap",
            "workspace-write-claims-upgrade",
            "workspace-write-ops-folder-map",
            "workspace-write-valid-from-persist",
          ])
          const replay = await f.runner.runWorkflow(workspaceHydrate.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: f.revision,
          })
          await replay.result({ timeoutMs: 30_000 })
          expect(await jobs()).toHaveLength(4)
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
          expect(
            f.tokenRequests.filter(
              (request) =>
                (request as { permissions?: { contents?: string } }).permissions
                  ?.contents === "write",
            ),
          ).toHaveLength(0)
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "queued maintenance jobs retain their work when an earlier job advances default",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          ...bootstrapWorkspaceFiles({
            displayName: "Workspace",
            existing: new Map(),
          }).map((file) => ({ path: file.path, body: file.content })),
          { path: "knowledge/a.md", body: "# A\n[B](b.md)\n" },
          {
            path: "knowledge/b.md",
            body: "---\nclaims:\n  - to: a.md\n---\n# B\n",
          },
        ],
      },
      async (f) => {
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        const { workspaceClaimsUpgrade } = await import(
          "../../openworkflow/workflows/workspace-claims-upgrade.js"
        )
        const { workspaceValidFromPersist } = await import(
          "../../openworkflow/workflows/workspace-valid-from-persist.js"
        )
        const { workspaceSemanticMerge } = await import(
          "../../openworkflow/workflows/workspace-semantic-merge.js"
        )
        runner.implementWorkflow(
          workspaceClaimsUpgrade.spec,
          workspaceClaimsUpgrade.fn,
        )
        runner.implementWorkflow(
          workspaceValidFromPersist.spec,
          workspaceValidFromPersist.fn,
        )
        runner.implementWorkflow(
          workspaceSemanticMerge.spec,
          workspaceSemanticMerge.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await f.worker.start()
          await f.handle.result({ timeoutMs: 30_000 })
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) =>
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId &&
              run.workflowName.startsWith("workspace-write-"),
          )
          expect(queued.map((run) => run.workflowName).sort()).toEqual([
            "workspace-write-claims-upgrade",
            "workspace-write-valid-from-persist",
          ])
          await worker.start()
          await expect
            .poll(
              async () =>
                Promise.all(
                  queued.map(
                    async (run) =>
                      (
                        await backend.getWorkflowRun({
                          workflowRunId: run.id,
                        })
                      )?.status,
                  ),
                ),
              { timeout: 45_000 },
            )
            .toEqual(["completed", "completed"])
          expect(
            f.git("--git-dir", f.remote, "show", "main:knowledge/a.md"),
          ).toContain("to: b.md")
          expect(
            f.git("--git-dir", f.remote, "show", "main:knowledge/b.md"),
          ).toContain("valid_from:")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("2")
        } finally {
          for (const run of (await backend.listWorkflowRuns({ limit: 100 }))
            .data) {
            if (
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId &&
              !["completed", "failed", "canceled"].includes(run.status)
            )
              await runner.cancelWorkflowRun(run.id)
          }
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)

it.each([
  {
    label: "capped",
    history: [
      { attempt: 1, remainder: 4 },
      { attempt: 2, remainder: 3 },
      { attempt: 3, remainder: 2 },
    ],
  },
  { label: "non-shrinking", history: [{ attempt: 1, remainder: 1 }] },
])(
  "hydrate stops $label concerns without blocking another kind",
  { timeout: 60_000 },
  async ({ history }) => {
    const { sql } = await import("drizzle-orm")
    const { withOrgIdContext } = await import("../../auth/withAuth.js")
    const { getOrgDb, withOrgDbContext } = await import("../../db/client.js")
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          ...bootstrapWorkspaceFiles({
            displayName: "Workspace",
            existing: new Map(),
          }).map((file) => ({ path: file.path, body: file.content })),
          { path: "knowledge/a.md", body: "# A\n[B](b.md)\n" },
          {
            path: "knowledge/b.md",
            body: "---\nclaims:\n  - to: a.md\n---\n# B\n",
          },
        ],
      },
      async (f) => {
        // Durable pre-upgrade history is fixture data; hydration and admission run natively.
        await withOrgIdContext(f.org, () =>
          withOrgDbContext(f.org.id, async () => {
            for (const entry of [
              ...history.map((entry) => ({ kind: "claims_upgrade", ...entry })),
              { kind: "valid_from_persist", attempt: 1, remainder: 2 },
            ]) {
              const payload = {
                revision: { ...f.revision, access: "write-default" },
                jobWorkspaceUrl: f.workspaceUrl,
                planning: {
                  rootSha: "a".repeat(40),
                  attempt: entry.attempt,
                  remainder: entry.remainder,
                },
              }
              await getOrgDb().execute(sql`insert into workspace_write_jobs
          (id, org_id, workspace_id, kind, desired_sha, commit_sha, generation, status, payload)
          values (${`wjob_${f.id}_${entry.kind}_${entry.attempt}`}, ${f.org.id}, ${f.workspaceId}, ${entry.kind}, ${"a".repeat(40)}, ${entry.kind === "claims_upgrade" && entry.attempt === history.at(-1)?.attempt ? f.sha : null}, ${f.revision.generation}, 'completed', ${JSON.stringify(payload)}::jsonb)`)
            }
          }),
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          await f.worker.start()
          await f.handle.result({ timeoutMs: 30_000 })
          const commands = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) =>
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId &&
              run.workflowName.startsWith("workspace-write-"),
          )
          expect(commands.map((run) => run.workflowName)).toEqual([
            "workspace-write-valid-from-persist",
          ])
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "a failed admission probe leaves planned jobs paused and resumable",
  { timeout: 60_000 },
  async () => {
    const { withOrgIdContext } = await import("../../auth/withAuth.js")
    const { listPausedWriteJobs } = await import(
      "../../models/workspace-write-jobs.js"
    )
    await withNativeHydrationFixture(
      { github: true, writeStatus: "writable" },
      async (f) => {
        await f.publish()
        const paused = await withOrgIdContext(f.org, () =>
          listPausedWriteJobs(f.workspaceId),
        )
        expect(paused.map((job) => job.kind).sort()).toEqual([
          "bootstrap",
          "ops_folder_map",
        ])
        expect(
          paused.every(
            (job) =>
              job.generation === f.revision.generation &&
              job.payload?.jobWorkspaceUrl === f.workspaceUrl,
          ),
        ).toBe(true)
      },
    )
  },
)
