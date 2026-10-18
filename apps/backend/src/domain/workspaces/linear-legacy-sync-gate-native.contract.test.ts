import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { encodeLinearTokensForDb } from "../../lib/connection-config.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { linearSyncEntity } from "../../openworkflow/workflows/linear-sync-entity.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"
import { cancelWorkflowRunIfOpen } from "../../test/open-workflow-runs.js"

// A Linear entity sync that writes a deletion starts no repository ingestion
// on its sync repository, with or without Workspace sources (CTX-651).
it.each([
  { withSources: false, ingestionRuns: 0 },
  { withSources: true, ingestionRuns: 0 },
])(
  "Linear entity sync starts $ingestionRuns ingestion runs when sources exist: $withSources",
  { timeout: 45_000 },
  async ({ withSources, ingestionRuns }) => {
    const connectionId = `con_gate_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const sourcesYaml = `version: 1\nsources:\n  - id: linear-issues\n    provider: linear\n    connection: ${connectionId}\n`
    const config =
      "version: 1\nsource: linear\nworkspace:\n  id: provider-workspace\n  name: Fixture\nscope: {}\n"
    await withNativeHydrationFixture(
      {
        namespaceId: openWorkflowNamespaceId(),
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        githubContentFiles: { "linear/config.yaml": config },
        files: [
          { path: "linear/config.yaml", body: config },
          ...(withSources
            ? [{ path: ".ctxpipe/sources.yaml", body: sourcesYaml }]
            : []),
          {
            path: "linear/issues/obsolete--issue-one.md",
            body: "# Deleted issue\n",
          },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const repo = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repo) throw new Error("Fixture repository missing")
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "linear",
              config: {
                ...encodeLinearTokensForDb(
                  { accessToken: "gate-fixture-token", refreshToken: null },
                  parseEnv(process.env),
                ),
                workspaceId: "provider-workspace",
                workspaceName: "Fixture",
                ownerUserId: "fixture-owner",
                status: "installed",
                repositoryId: repo.id,
                branch: "main",
                enabled: true,
                setupPhase: "live",
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        f.runner.implementWorkflow(linearSyncEntity.spec, linearSyncEntity.fn)
        f.runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        const handle = await f.runner.runWorkflow(linearSyncEntity.spec, {
          orgId: f.org.id,
          connectionId,
          entityType: "issue",
          externalId: "issue-one",
          action: "delete",
        })
        try {
          await worker.start()
          expect(await handle.result({ timeoutMs: 20_000 })).toEqual({
            written: 0,
            deleted: 1,
            failures: [],
          })
          const runs = (await f.backend.listWorkflowRuns({ limit: 100 })).data
          expect(
            runs.filter(
              (run) =>
                run.workflowName === "repository-ingestion-orchestrator" &&
                (
                  run.input as {
                    repositoryId?: string
                    indexingReason?: string
                  } | null
                )?.repositoryId === repo.id &&
                (run.input as { indexingReason?: string } | null)
                  ?.indexingReason === "Applying Linear updates",
            ),
          ).toHaveLength(ingestionRuns)
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 100 }))
            .data) {
            if (!["completed", "failed", "canceled"].includes(run.status))
              await cancelWorkflowRunIfOpen(f.backend, run.id)
          }
          await worker.stop()
        }
      },
    )
  },
)
