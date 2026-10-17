import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { persistBoundWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

// The payload that the old pipeline queued (CTX-642 deletes that pipeline).
function oldExtraction(f: { workspaceUrl: string; sha: string }) {
  return {
    repositoryId: "repo_captured",
    repositoryUrl: f.workspaceUrl,
    sourceSha: f.sha,
    retraction: { mode: "full", observedAt: "2026-10-01T00:00:00.000Z" },
    capture: { scope: "full", extractorVersion: 3, roots: ["."] },
  }
}

async function jobStatus(orgId: string, jobId: string) {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ status: workspaceWriteJobs.status })
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, jobId)),
  )
  return row?.status
}

it(
  "refuses an old extract ingest at admission and completes its paused job, so no resume admits it again",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.handle.cancel()
        const jobId = `wjob_${f.id}_retired`
        const revision = {
          ...(await f.resolveRevision()),
          access: "write-default" as const,
        }
        await withOrgIdContext(f.org, () =>
          persistBoundWriteJob({
            admissionStatus: "paused",
            id: jobId,
            kind: "extract_ingest",
            revision,
            extraction: oldExtraction(f),
          }),
        )
        const errors: Error[] = []
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "extract_ingest",
                extraction: oldExtraction(f),
              },
              { error: (error) => errors.push(error) },
            ),
          ),
        ).toEqual({ started: false })
        expect(errors.map((error) => error.message)).toEqual([
          "The old ingestion pipeline is retired. Admission refuses its extract_ingest write; ingestion v2 publishes to a Workspace at format 3 or more.",
        ])
        expect(await jobStatus(f.org.id, jobId)).toBe("completed")
      },
    )
  },
)

it.each(["extract-ingest", "semantic-merge"] as const)(
  "ends a queued %s run of the old pipeline with no write",
  { timeout: 60_000 },
  async (kind) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { workspaceExtractIngest } = await import(
          "../../openworkflow/workflows/workspace-extract-ingest.js"
        )
        const { workspaceSemanticMerge } = await import(
          "../../openworkflow/workflows/workspace-semantic-merge.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(
          workspaceExtractIngest.spec,
          workspaceExtractIngest.fn,
        )
        runner.implementWorkflow(
          workspaceSemanticMerge.spec,
          workspaceSemanticMerge.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const jobId = `wjob_${f.id}_${kind}`
          const revision = {
            ...(await f.resolveRevision()),
            access: "write-default" as const,
          }
          const files = [
            {
              path: "knowledge/services/ledger.md",
              content: "---\nkind: Service\n---\n\n# Ledger\n",
            },
          ]
          await withOrgIdContext(f.org, () =>
            persistBoundWriteJob({
              id: jobId,
              revision,
              extraction: oldExtraction(f),
              ...(kind === "extract-ingest"
                ? { kind: "extract_ingest" as const }
                : {
                    kind: "semantic_merge" as const,
                    previousSha: f.sha,
                    files,
                    deletePaths: [],
                  }),
            }),
          )
          // Raw input, as a queued run of the old pipeline holds it.
          const base = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision,
            extraction: oldExtraction(f),
          }
          const run =
            kind === "extract-ingest"
              ? await runner.runWorkflow(workspaceExtractIngest.spec, {
                  ...base,
                  publishPipeline: "legacy",
                } as never)
              : await runner.runWorkflow(workspaceSemanticMerge.spec, {
                  ...base,
                  origin: "extraction",
                  previousSha: f.sha,
                  files,
                  deletePaths: [],
                } as never)
          expect(await run.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: false,
            reason: "legacy_ingestion_retired",
          })
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
          expect(await jobStatus(f.org.id, jobId)).toBe("completed")
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
