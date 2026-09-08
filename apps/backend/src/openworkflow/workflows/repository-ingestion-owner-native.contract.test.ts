import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
import {
  getRepositoryForOrg,
  listRepositoriesForGithubConnection,
  listRepositoriesForOrg,
  markRepositoryIndexingReady,
} from "../../models/repositories.js"
import { prepareRepositoryIngestionRequest } from "../../models/repository-ingestion-requests.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withCanceledNativeInsert } from "../../test/native-workflow-insert-failure.js"
import { ow } from "../client.js"
import { enqueueRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { repositoryIngestionOrchestrator } from "./repository-ingestion-orchestrator.js"

it(
  "projects a canceled native ingestion owner without a worker failure callback",
  { timeout: 20_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const repository = await withOrgIdContext(f.org, () =>
        ensureOrgRepositoryForGitUrl({
          orgId: f.org.id,
          gitUrl: f.workspaceUrl,
          githubConnectionId: f.connectionId,
        }),
      )
      if (!repository) throw new Error("Fixture repository missing")
      const owner = await enqueueRepositoryIngestionWorkflow(
        { orgId: f.org.id, repositoryId: repository.id },
        {
          error: (error) => {
            throw error
          },
        },
      )
      const original = await prepareRepositoryIngestionRequest({
        orgId: f.org.id,
        repositoryId: repository.id,
      })
      await ow.cancelWorkflowRun(owner.workflowRunId)
      await withOrgDbContext(f.org.id, () =>
        markRepositoryIndexingReady({
          repositoryId: repository.id,
          targetHash: "b".repeat(40),
          requestId: original.requestId,
        }),
      )
      expect(await getRepositoryForOrg(f.org.id, repository.id)).toMatchObject({
        id: repository.id,
        indexingStatus: "failed",
        indexingError: "Repository ingestion canceled",
        indexReady: false,
        lastIngestedHash: null,
        indexingStepKey: null,
      })
      expect(await listRepositoriesForOrg(f.org.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: repository.id,
            indexingStatus: "failed",
          }),
        ]),
      )
      expect(
        await withOrgIdContext(f.org, () =>
          listRepositoriesForGithubConnection(f.connectionId),
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: repository.id,
            indexingStatus: "failed",
          }),
        ]),
      )
      expect(await getRepositoryForOrg("org_other", repository.id)).toBeNull()
      await enqueueRepositoryIngestionWorkflow(
        { orgId: f.org.id, repositoryId: repository.id },
        {
          error: (error) => {
            throw error
          },
        },
      )
      await withOrgDbContext(f.org.id, () =>
        markRepositoryIndexingReady({
          repositoryId: repository.id,
          targetHash: "a".repeat(40),
          requestId: original.requestId,
        }),
      )
      expect(await getRepositoryForOrg(f.org.id, repository.id)).toMatchObject({
        lastIngestedHash: null,
        indexReady: false,
        indexingStatus: "queued",
        indexingError: null,
        indexingFailedAt: null,
      })
    })
  },
)

it(
  "projects a native child cancellation after the orchestrator resumes",
  { timeout: 25_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const repository = await withOrgIdContext(f.org, () =>
        ensureOrgRepositoryForGitUrl({
          orgId: f.org.id,
          gitUrl: f.workspaceUrl,
        }),
      )
      if (!repository) throw new Error("Fixture repository missing")
      f.runner.implementWorkflow(
        repositoryIngestionOrchestrator.spec,
        repositoryIngestionOrchestrator.fn,
      )
      const owner = await f.runner.runWorkflow(
        repositoryIngestionOrchestrator.spec,
        { orgId: f.org.id, repositoryId: repository.id },
      )
      // No ingestion worker is registered: exercise a child waiting for a replacement worker.
      const worker = f.runner.newWorker({ concurrency: 1 })
      try {
        await worker.start()
        let childId: string | undefined
        await expect
          .poll(
            async () => {
              childId = (
                await f.backend.listWorkflowRuns({ limit: 100 })
              ).data.find(
                (run) => run.workflowName === "repository-ingestion",
              )?.id
              return childId
            },
            { timeout: 5_000 },
          )
          .toBeTruthy()
        if (!childId) throw new Error("Native ingestion child missing")
        expect(
          await getRepositoryForOrg(f.org.id, repository.id),
        ).toMatchObject({ indexingStatus: "running", indexingError: null })
        await f.runner.cancelWorkflowRun(childId)
        await expect(owner.result({ timeoutMs: 10_000 })).rejects.toThrow()
        expect(
          await getRepositoryForOrg(f.org.id, repository.id),
        ).toMatchObject({ indexingStatus: "failed", indexingStepKey: null })
      } finally {
        await worker.stop()
      }
    })
  },
)

it(
  "rejects failed native admission without marking the repository queued, then retries the same intent",
  { timeout: 20_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const repository = await withOrgIdContext(f.org, () =>
        ensureOrgRepositoryForGitUrl({
          orgId: f.org.id,
          gitUrl: f.workspaceUrl,
        }),
      )
      if (!repository) throw new Error("Fixture repository missing")
      const input = { orgId: f.org.id, repositoryId: repository.id }
      const errors: Error[] = []
      await expect(
        withCanceledNativeInsert(f.databaseUrl, () =>
          enqueueRepositoryIngestionWorkflow(input, {
            error: (error) => errors.push(error),
          }),
        ),
      ).rejects.toThrow()
      expect(errors).toHaveLength(1)
      expect(await getRepositoryForOrg(f.org.id, repository.id)).toMatchObject({
        indexingStatus: null,
        indexingError: null,
      })
      const admitted = await Promise.all([
        enqueueRepositoryIngestionWorkflow(input, {
          error: (error) => errors.push(error),
        }),
        enqueueRepositoryIngestionWorkflow(input, {
          error: (error) => errors.push(error),
        }),
      ])
      expect(admitted[0]?.workflowRunId).toBeTruthy()
      expect(admitted[1]).toEqual(admitted[0])
      expect(await getRepositoryForOrg(f.org.id, repository.id)).toMatchObject({
        indexingStatus: "queued",
        indexingError: null,
      })
    })
  },
)

it(
  "upgrades a legacy native owner once and preserves subsequently admitted requests",
  { timeout: 20_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const repository = await withOrgIdContext(f.org, () =>
        ensureOrgRepositoryForGitUrl({
          orgId: f.org.id,
          gitUrl: f.workspaceUrl,
        }),
      )
      if (!repository) throw new Error("Fixture repository missing")
      const input = { orgId: f.org.id, repositoryId: repository.id }
      const legacy = await f.runner.runWorkflow(
        repositoryIngestionOrchestrator.spec,
        input,
      )
      await legacy.cancel()
      const { Pool } = await import("pg")
      const { ownerUrlForMigrate } = await import(
        "../../db/owner-migrate-url.js"
      )
      const { backfillRepositoryIngestionRequests } = await import(
        "../../db/backfill-repository-ingestion-requests.js"
      )
      const pool = new Pool({
        connectionString: ownerUrlForMigrate(f.databaseUrl),
      })
      try {
        await backfillRepositoryIngestionRequests(pool)
        expect(
          await getRepositoryForOrg(f.org.id, repository.id),
        ).toMatchObject({
          indexingStatus: "failed",
          indexingError: "Repository ingestion canceled",
        })
        await enqueueRepositoryIngestionWorkflow(input, {
          error: (error) => {
            throw error
          },
        })
        await backfillRepositoryIngestionRequests(pool)
        expect(
          await getRepositoryForOrg(f.org.id, repository.id),
        ).toMatchObject({ indexingStatus: "queued", indexingError: null })
      } finally {
        await pool.end()
      }
    })
  },
)

it(
  "preserves search-index warnings when the native ingestion owner completes successfully",
  { timeout: 20_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      const repository = await withOrgIdContext(f.org, () =>
        ensureOrgRepositoryForGitUrl({
          orgId: f.org.id,
          gitUrl: f.workspaceUrl,
        }),
      )
      if (!repository) throw new Error("Fixture repository missing")
      const { activateRepositoryIngestionRequest } = await import(
        "../../models/repository-ingestion-requests.js"
      )
      const { markRepositoryIndexingIssues } = await import(
        "../../models/repositories.js"
      )
      // Historical successful native execution with a degraded search result.
      f.runner.implementWorkflow(
        repositoryIngestionOrchestrator.spec,
        async ({ input, run, step }) => {
          const requestId = await step.run(
            { name: "activate-ingestion-request" },
            () => activateRepositoryIngestionRequest(input, run.id),
          )
          await step.run({ name: "mark-success" }, () =>
            withOrgDbContext(f.org.id, () =>
              markRepositoryIndexingIssues({
                repositoryId: repository.id,
                requestId,
                error: "Search index unavailable",
              }),
            ),
          )
          return {
            repositoryId: repository.id,
            targetHash: f.sha,
            sourceBranch: "main",
          }
        },
      )
      const worker = f.runner.newWorker({ concurrency: 1 })
      try {
        await worker.start()
        const owner = await f.runner.runWorkflow(
          repositoryIngestionOrchestrator.spec,
          { orgId: f.org.id, repositoryId: repository.id },
        )
        await owner.result({ timeoutMs: 10_000 })
        expect(
          await getRepositoryForOrg(f.org.id, repository.id),
        ).toMatchObject({
          indexingStatus: "complete_with_issues",
          indexingError: "Search index unavailable",
          indexReady: false,
          lastIngestedHash: null,
        })
      } finally {
        await worker.stop()
      }
    })
  },
)

it(
  "rejects extraction superseded during write credential issuance before native Git push",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.handle.cancel()
        const repository = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repository) throw new Error("Fixture repository missing")
        const input = { orgId: f.org.id, repositoryId: repository.id }
        const logger = {
          error: (error: Error) => {
            throw error
          },
        }
        await enqueueRepositoryIngestionWorkflow(input, logger)
        const original = await prepareRepositoryIngestionRequest(input)
        const { workspaceExtractIngest } = await import(
          "./workspace-extract-ingest.js"
        )
        f.runner.implementWorkflow(
          workspaceExtractIngest.spec,
          workspaceExtractIngest.fn,
        )
        let superseded = false
        f.onWriteCredentialRequest(async () => {
          if (superseded) return
          superseded = true
          await enqueueRepositoryIngestionWorkflow(
            { ...input, targetBranch: "replacement" },
            logger,
          )
        })
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const handle = await f.runner.runWorkflow(
            workspaceExtractIngest.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_source_owner`,
              revision: { ...f.revision, access: "write-default" },
              extraction: {
                repositoryId: repository.id,
                repositoryUrl: f.workspaceUrl,
                sourceSha: f.sha,
                ingestionRequestId: original.requestId,
                objects: [
                  {
                    kind: "Service",
                    deduplicationKey: "svc:billing",
                    name: "Billing",
                    summary: "Captured service",
                  },
                ],
                claims: [],
              },
            },
          )
          await expect(handle.result({ timeoutMs: 15_000 })).rejects.toThrow()
          expect(superseded).toBe(true)
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
