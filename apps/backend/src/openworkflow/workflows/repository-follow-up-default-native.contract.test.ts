import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { getRepositoryForOrg } from "../../models/repositories.js"
import { withNativeIndexFixture } from "../../test/native-index-fixture.js"
import { repositoryIndex } from "./repository-index.js"
import { repositoryIngestion } from "./repository-ingestion.js"

it.each(["default", "explicit"] as const)(
  "keeps %s branch selection across producer restart and follow-up",
  { timeout: 60_000 },
  async (selection) => {
    await withNativeIndexFixture(async (f) => {
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(repositoryCheckouts).values({
          id: `co_${f.namespace}`,
          orgId: f.org.id,
          repositoryId: f.repositoryId,
          ref: "trunk",
          checkoutKey: "default",
        }),
      )
      const repository = await getRepositoryForOrg(f.org.id, f.repositoryId)
      if (!repository) throw new Error("Fixture repository missing")
      const backend = await BackendPostgres.connect(f.databaseUrl, {
        runMigrations: false,
        namespaceId: `${f.namespace}_producer`,
      })
      const previous = new OpenWorkflow({ backend })
      const resumed = new OpenWorkflow({ backend })
      previous.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
      resumed.implementWorkflow(repositoryIndex.spec, repositoryIndex.fn)
      let captured!: () => void
      const ready = new Promise<void>((resolve) => {
        captured = resolve
      })
      previous.implementWorkflow(repositoryIngestion.spec, async ({ step }) => {
        await step.run({ name: "mark-running" }, () => undefined)
        await step.run({ name: "get-repository" }, () => repository)
        await step.run({ name: "capture-extraction-destination" }, () => null)
        await step.run({ name: "set-step-resolving-ref" }, () => undefined)
        await step.run({ name: "resolve-ref" }, () => ({
          hash: f.sha,
          branch: "trunk",
        }))
        await step.runWorkflow(
          repositoryIndex.spec,
          { orgId: f.org.id, repositoryId: f.repositoryId, targetHash: f.sha },
          { name: "repository-index" },
        )
        captured()
        await step.sleep("fixture-restart-boundary", "5 seconds")
        return {
          repositoryId: f.repositoryId,
          targetHash: f.sha,
          sourceBranch: "trunk",
        }
      })
      let worker = previous.newWorker({ concurrency: 1 })
      try {
        await worker.start()
        const owner = await previous.runWorkflow(repositoryIngestion.spec, {
          orgId: f.org.id,
          repositoryId: f.repositoryId,
          ...(selection === "explicit" ? { targetBranch: "trunk" } : {}),
        })
        await Promise.race([
          ready,
          owner.result({ timeoutMs: 30_000 }).then(() => {
            throw new Error("Historical capture completed before restart")
          }),
        ])
        await worker.stop()
        f.git("checkout", "-b", "next-default")
        f.git(
          "-c",
          "user.name=Contract",
          "-c",
          "user.email=contract@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "New remote default tip",
        )
        resumed.implementWorkflow(
          repositoryIngestion.spec,
          repositoryIngestion.fn,
        )
        worker = resumed.newWorker({ concurrency: 1 })
        await worker.start()
        await owner.result({ timeoutMs: 15_000 })
        expect(
          await getRepositoryForOrg(f.org.id, f.repositoryId),
        ).toMatchObject({
          indexingStatus: selection === "default" ? "queued" : "ready",
        })
      } finally {
        await worker.stop()
        await backend.stop()
      }
    }, false)
  },
)
