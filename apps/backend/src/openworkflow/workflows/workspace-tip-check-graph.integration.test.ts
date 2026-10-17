import { symlinkSync } from "node:fs"
import { join } from "node:path"
import { inArray } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { workspaceTipCheck } from "./workspace-tip-check.js"

it(
  "enqueues one rebuild for each ready Workspace whose graph is missing",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture({}, async (f) => {
      await f.publish()
      const rows = Array.from({ length: 25 }, (_, index) => {
        const id = `ws_batch_${index}_${f.id}`
        const remote = join(f.directory, `batch-${index}.git`)
        symlinkSync(f.remote, remote)
        const revision = {
          ...f.revision,
          workspaceId: id,
          remote: { url: remote, connectionId: null },
        }
        return {
          id,
          orgId: f.org.id,
          slug: `batch-${index}`,
          displayName: `Batch ${index}`,
          workspaceRepositoryUrl: remote,
          desiredSha: f.sha,
          desiredDefaultBranch: "main",
          activeRevision: revision,
          activeProjectionUrl: remote,
          activeProjectionSha: f.sha,
          indexedSha: f.sha,
          hydrateStatus: "ready",
          writeStatus: "read_only",
          updatedAt: new Date(2000, 0, 1, 0, 0, index),
          hydratePhases: {
            url: remote,
            sha: f.sha,
            revision,
            embeddings: true,
            graph: { revision, result: { kind: "ready" as const } },
            index: { revision, result: { kind: "ready" as const } },
          },
        }
      })
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(workspaces).values(rows),
      )
      const queue = await BackendPostgres.connect(f.databaseUrl, {
        runMigrations: false,
        namespaceId: openWorkflowNamespaceId(),
      })
      try {
        const rebuilds = async () => {
          const runs = (await queue.listWorkflowRuns({ limit: 1000 })).data
          const ids = runs.flatMap((run) => {
            const input = run.input as {
              workspaceId?: string
              revision?: unknown
            }
            return run.workflowName === "workspace-hydrate" &&
              input.revision !== undefined &&
              rows.some((row) => row.id === input.workspaceId)
              ? [input.workspaceId]
              : []
          })
          return [...new Set(ids)]
        }
        const run = await f.runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: f.org.id,
        })
        await run.result({ timeoutMs: 30_000 })
        expect(await rebuilds()).toHaveLength(rows.length)
      } finally {
        await queue.stop()
        await withOrgDbContext(f.org.id, (db) =>
          db.delete(workspaces).where(
            inArray(
              workspaces.id,
              rows.map((row) => row.id),
            ),
          ),
        )
      }
    })
  },
)
