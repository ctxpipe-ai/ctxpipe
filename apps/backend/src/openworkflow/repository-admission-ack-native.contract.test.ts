import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { ensureOrgRepositoryForGitUrl } from "../domain/workspaces/ensure-org-repository.js"
import { getRepositoryForOrg } from "../models/repositories.js"
import { withNativeHydrationFixture } from "../test/native-hydration-fixture.js"
import { withLostNativeWorkflowInsertAck } from "../test/native-workflow-ack-loss.js"
import { enqueueRepositoryIngestionWorkflow } from "./enqueue-repository-ingestion.js"

it(
  "acknowledges one repository ingestion owner when its committed native run ID is lost",
  { timeout: 30_000 },
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
      const result = await withLostNativeWorkflowInsertAck(
        f.databaseUrl,
        "repository-ingestion-orchestrator",
        async (databaseUrl) => {
          const output = await promisify(execFile)(
            "bun",
            [
              fileURLToPath(
                new URL(
                  "../test/native-repository-admission-ack-client.ts",
                  import.meta.url,
                ),
              ),
              f.org.id,
              repository.id,
            ],
            {
              env: { ...process.env, DATABASE_URL: databaseUrl },
              timeout: 20_000,
              maxBuffer: 1024 * 1024,
            },
          )
          return JSON.parse(output.stdout) as { workflowRunId: string }
        },
      )
      expect(result.lostAcknowledgement).toBe(true)
      expect(result.result.workflowRunId).toBeTruthy()
      expect(await getRepositoryForOrg(f.org.id, repository.id)).toMatchObject({
        indexingStatus: "queued",
      })
      const retried = await enqueueRepositoryIngestionWorkflow(
        { orgId: f.org.id, repositoryId: repository.id },
        {
          error: (error) => {
            throw error
          },
        },
      )
      expect(retried).toEqual(result.result)
    })
  },
)
