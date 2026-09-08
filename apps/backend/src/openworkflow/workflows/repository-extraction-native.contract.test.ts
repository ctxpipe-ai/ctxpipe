import { defineWorkflow, OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { repositoryIndex } from "./repository-index.js"
import { repositoryIngestion } from "./repository-ingestion.js"
import { workspaceExtractIngest } from "./workspace-extract-ingest.js"

it(
  "publishes a captured repository extraction after a native worker restart",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "AGENTS.md",
            body: "# Workspace repository\nOwner instructions.\n",
          },
        ],
      },
      async (f) => {
        await f.handle.cancel()
        const repository = await withOrgIdContext(f.org, async () => {
          const created = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          })
          if (!created) throw new Error("Fixture repository missing")
          return withOrgDbContext(f.org.id, (db) =>
            db.query.repositories.findFirst({
              where: { id: { eq: created.id } },
            }),
          )
        })
        if (!repository) throw new Error("Fixture repository missing")
        const extracted = {
          extractedObjects: [
            {
              kind: "Service",
              deduplicationKey: `svc:${repository.id}:billing`,
              name: "Billing",
              summary: "Captured billing service.",
            },
          ],
          extractedClaims: [
            {
              subjectRef: `svc:${repository.id}:billing`,
              objectRef: repository.id,
              predicate: "IMPLEMENTED_IN",
              confidence: 0.9,
              sourceId: `extractKind:${repository.id}:billing:${f.sha}`,
            },
          ],
        }
        let captured!: () => void
        const ready = new Promise<void>((resolve) => {
          captured = resolve
        })
        // Restore an old worker's durable source capture using public native steps.
        // These are historical I/O results; the resumed production workflow owns publication.
        const historicalIndex = defineWorkflow(
          { name: "repository-index" },
          async () => ({
            indexedAt: new Date().toISOString(),
            targetHash: f.sha,
            ingestMode: "full",
            changedPaths: [],
            deletedPaths: [],
            renames: [],
            searchIndexOk: true,
          }),
        )
        const historical = defineWorkflow(
          repositoryIngestion.spec,
          async ({ step }) => {
            await step.run({ name: "mark-running" }, () => undefined)
            await step.run({ name: "get-repository" }, () => repository)
            await step.run({ name: "set-step-resolving-ref" }, () => undefined)
            await step.run({ name: "resolve-ref" }, () => ({
              hash: f.sha,
              branch: "main",
            }))
            await step.runWorkflow(
              historicalIndex.spec,
              {
                repositoryId: repository.id,
                orgId: f.org.id,
                targetHash: f.sha,
                githubConnectionId: f.connectionId,
              },
              { name: "repository-index" },
            )
            await step.run({ name: "set-step-retracting" }, () => undefined)
            await step.run({ name: "retractionStep" }, () => ({
              retractionStats: {},
              retractionGraphEffects: {
                deletedClaimIds: [],
                refreshedClaimIds: [],
                deletedObjectIds: [],
              },
            }))
            await step.run({ name: "identify-roots" }, () => ({
              roots: ["billing"],
            }))
            await step.run({ name: "extract-kind:billing" }, () => extracted)
            await step.run({ name: "identify:billing" }, () => extracted)
            await step.run({ name: "deduplicateAndStore" }, () => ({
              objectIds: [],
              touchedObjectIds: [],
              claimsForProjection: [],
            }))
            await step.run({ name: "project" }, () => ({}))
            await step.run({ name: "embed" }, () => ({}))
            await step.run({ name: "enqueue-follow-up-if-tip-ahead" }, () => ({
              enqueued: false,
            }))
            captured()
            await step.sleep("fixture-restart-boundary", "5 seconds")
            return {
              repositoryId: repository.id,
              targetHash: f.sha,
              sourceBranch: "main",
            }
          },
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
          namespaceId: f.id,
        })
        const resumed = new OpenWorkflow({ backend })
        const previous = new OpenWorkflow({ backend })
        previous.implementWorkflow(historicalIndex.spec, historicalIndex.fn)
        previous.implementWorkflow(historical.spec, historical.fn)
        let worker = previous.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const handle = await previous.runWorkflow(historical.spec, {
            orgId: f.org.id,
            repositoryId: repository.id,
          })
          await Promise.race([
            ready,
            handle.result({ timeoutMs: 15_000 }).then(() => {
              throw new Error("Historical owner completed before restart")
            }),
          ])
          await worker.stop()
          resumed.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
          resumed.implementWorkflow(
            repositoryIngestion.spec,
            repositoryIngestion.fn,
          )
          resumed.implementWorkflow(
            workspaceExtractIngest.spec,
            workspaceExtractIngest.fn,
          )
          worker = resumed.newWorker({ concurrency: 1 })
          await worker.start()
          await handle.result({ timeoutMs: 25_000 })
          expect(
            f.git("--git-dir", f.remote, "diff", "--name-only", f.sha, "main"),
          ).toBe("knowledge/services/billing.md")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "main:knowledge/services/billing.md",
            ),
          ).toContain("Captured billing service.")
          const markdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "main:knowledge/services/billing.md",
          )
          expect(markdown).toContain("to: ../../AGENTS.md")
          expect(markdown).toContain("predicate: IMPLEMENTED_IN")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("1")
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
