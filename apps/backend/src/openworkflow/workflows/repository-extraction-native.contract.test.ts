import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineWorkflow, OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureRepositoryExtractionTarget } from "../../domain/workspaces/capture-repository-extraction.js"
import { ensureOrgRepositoryForGitUrl } from "../../domain/workspaces/ensure-org-repository.js"
import { persistOrgFirstWorkspace } from "../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { enqueueRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { repositoryIndex } from "./repository-index.js"
import { repositoryIngestion } from "./repository-ingestion.js"
import { workspaceExtractIngest } from "./workspace-extract-ingest.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"

it.each([
  "workspace",
  "superseded-before-resume",
  "too-many-roots",
  "linked",
  "unlinked-before-resume",
  "edited-before-resume",
] as const)(
  "resumes captured repository extraction against canonical source ownership (%s)",
  { timeout: 45_000 },
  async (mode) => {
    const ownSource = mode === "workspace" || mode === "too-many-roots"
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
          {
            path: "repositories/source.md",
            body: "---\ngit: https://github.com/fixture/extraction-source\n---\n",
          },
        ],
      },
      async (f) => {
        await f.handle.cancel()
        const repository = await withOrgIdContext(f.org, async () => {
          const created = await ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: ownSource
              ? f.workspaceUrl
              : "https://github.com/fixture/extraction-source",
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
        if (!ownSource)
          await withOrgIdContext(f.org, () =>
            persistOrgFirstWorkspace({
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              sourceRepositoryId: repository.id,
            }),
          )
        const extracted = {
          extractedObjects: [
            {
              kind: "Service",
              deduplicationKey: `svc:${repository.id}:billing`,
              name: "Billing",
              summary: "Captured billing service.",
            },
            {
              kind: "API",
              deduplicationKey: `api:${repository.id}:billing`,
              name: "Billing API",
              summary: "Captured billing API.",
              payload: {
                framework: undefined,
                openApiSpec: undefined,
                routePaths: undefined,
                openApiPath: undefined,
              },
            },
          ],
          extractedClaims: [
            {
              subjectRef: repository.id,
              objectRef: `svc:${repository.id}:billing`,
              predicate: "HAS_SERVICE",
              confidence: 0.9,
              sourceId: `extractKind:${repository.id}:billing:${f.sha}`,
            },
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
            await step.run({ name: "capture-extraction-destination" }, () =>
              withOrgIdContext(f.org, () =>
                captureRepositoryExtractionTarget({
                  orgId: f.org.id,
                  repositoryUrl: repository.gitUrl,
                  env: parseEnv(process.env),
                }),
              ),
            )
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
            const roots =
              mode === "too-many-roots"
                ? Array.from({ length: 129 }, (_, i) => `root-${i}`)
                : ["billing"]
            await step.run({ name: "identify-roots" }, () => ({ roots }))
            for (const root of roots) {
              await step.run({ name: `extract-kind:${root}` }, () => extracted)
              await step.run({ name: `identify:${root}` }, () => extracted)
            }
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
          if (mode === "superseded-before-resume")
            await enqueueRepositoryIngestionWorkflow(
              { orgId: f.org.id, repositoryId: repository.id },
              {
                error: (error) => {
                  throw error
                },
              },
            )
          if (mode === "unlinked-before-resume") {
            f.git("rm", "-f", "repositories/source.md")
            f.git("commit", "-m", "Unlink source repository")
            f.git("push", f.remote, "main")
          }
          if (mode === "edited-before-resume") {
            writeFileSync(
              join(f.directory, "repositories/source.md"),
              "---\ngit: https://github.com/fixture/extraction-source\nbranch: replacement\n---\n",
            )
            f.git("add", "repositories/source.md")
            f.git("commit", "-m", "Select a different source branch")
            f.git("push", f.remote, "main")
          }
          resumed.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
          resumed.implementWorkflow(
            repositoryIngestion.spec,
            repositoryIngestion.fn,
          )
          resumed.implementWorkflow(
            workspaceExtractIngest.spec,
            workspaceExtractIngest.fn,
          )
          resumed.implementWorkflow(
            workspaceSemanticMerge.spec,
            workspaceSemanticMerge.fn,
          )
          worker = resumed.newWorker({ concurrency: 1 })
          await worker.start()
          if (mode === "superseded-before-resume") {
            await expect(handle.result({ timeoutMs: 10_000 })).rejects.toThrow()
            expect(
              (
                await backend.getWorkflowRun({
                  workflowRunId: handle.workflowRun.id,
                })
              )?.error?.message,
            ).toContain("Repository ingestion request superseded")
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            return
          }
          if (mode === "too-many-roots") {
            await expect(handle.result({ timeoutMs: 10_000 })).rejects.toThrow()
            const persisted = await backend.getWorkflowRun({
              workflowRunId: handle.workflowRun.id,
            })
            expect(persisted?.error?.message).toContain(
              "Extraction root capture exceeds 128 roots",
            )
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            return
          }
          if (
            mode === "unlinked-before-resume" ||
            mode === "edited-before-resume"
          ) {
            await expect(handle.result({ timeoutMs: 15_000 })).rejects.toThrow()
            const owner = (
              await backend.listWorkflowRuns({ limit: 100 })
            ).data.find(
              (run) => run.workflowName === "workspace-write-extract-ingest",
            )
            if (!owner) throw new Error("Captured extraction owner missing")
            const attempts = await backend.listStepAttempts({
              workflowRunId: owner.id,
              limit: 100,
            })
            expect(attempts.data).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  status: "failed",
                  error: expect.objectContaining({
                    message: "Extraction source declaration changed",
                  }),
                }),
              ]),
            )
            expect(
              f.git(
                "--git-dir",
                f.remote,
                "diff",
                "--name-only",
                f.sha,
                "main",
              ),
            ).toBe("repositories/source.md")
            expect(
              f.git(
                "--git-dir",
                f.remote,
                "rev-list",
                "--count",
                `${f.sha}..main`,
              ),
            ).toBe("1")
            return
          }
          await handle.result({ timeoutMs: 25_000 })
          const repositoryPath = ownSource
            ? "AGENTS.md"
            : "repositories/source.md"
          const repositoryMarkdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            `main:${repositoryPath}`,
          )
          expect(repositoryMarkdown).toContain("predicate: HAS_SERVICE")
          if (!ownSource)
            expect(repositoryMarkdown).toContain(
              "git: https://github.com/fixture/extraction-source",
            )
          expect(
            f.git("--git-dir", f.remote, "diff", "--name-only", f.sha, "main"),
          ).toBe(
            [
              "knowledge/apis/billing-api.md",
              "knowledge/services/billing.md",
              repositoryPath,
            ]
              .sort()
              .join("\n"),
          )
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
          expect(markdown).toContain(
            ownSource
              ? "to: ../../AGENTS.md"
              : "to: ../../repositories/source.md",
          )
          expect(markdown).toContain("predicate: IMPLEMENTED_IN")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "main:knowledge/apis/billing-api.md",
            ),
          ).toContain("Captured billing API.")
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
