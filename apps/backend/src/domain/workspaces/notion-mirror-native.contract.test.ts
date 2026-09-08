import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { encodeNotionTokensForDb } from "../../lib/connection-config.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { getNotionBindingWithRepoByConnectionId } from "../../models/notion-connector.js"
import { notionSyncContent } from "../../openworkflow/workflows/notion-sync-content.js"
import { notionSyncEntity } from "../../openworkflow/workflows/notion-sync-entity.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it.each(["entity", "full"] as const)(
  "captures a Notion %s deletion without persisting its credential and runs one native mirror child",
  { timeout: 45_000 },
  async (mode) => {
    const config = "version: 1\nsource: notion\nresources: []\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        githubContentFiles: { "notion/config.yaml": config },
        files: [
          { path: "notion/config.yaml", body: config },
          {
            path: "notion/pages/obsolete--page-one/index.md",
            body: "# Deleted issue\n",
          },
          { path: "knowledge/owner.md", body: "# Owner text\n" },
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
        const connectionId = `con_${f.id}_notion`
        const fixtureToken = "native-notion-fixture-token"
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "notion",
              config: {
                ...encodeNotionTokensForDb(
                  { accessToken: fixtureToken, refreshToken: null },
                  parseEnv(process.env),
                ),
                workspaceId: "provider-workspace",
                workspaceName: "Fixture",
                ownerUserId: "fixture-owner",
                status: "installed",
                repositoryId: repo.id,
                branch: "main",
                enabled: true,
                setupPhase: mode === "full" ? "initial_sync" : "live",
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        f.runner.implementWorkflow(notionSyncContent.spec, notionSyncContent.fn)
        f.runner.implementWorkflow(notionSyncEntity.spec, notionSyncEntity.fn)
        f.runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        const handle =
          mode === "full"
            ? await f.runner.runWorkflow(notionSyncContent.spec, {
                orgId: f.org.id,
                orgSlug: f.org.slug,
                connectionId,
              })
            : await f.runner.runWorkflow(notionSyncEntity.spec, {
                orgId: f.org.id,
                connectionId,
                entityType: "page",
                externalId: "page-one",
                action: "delete",
              })
        try {
          await worker.start()
          await expect
            .poll(
              async () =>
                (
                  await f.backend.listStepAttempts({
                    workflowRunId: handle.workflowRun.id,
                  })
                ).data.some((attempt) => attempt.status === "completed"),
              { timeout: 15_000 },
            )
            .toBe(true)
          expect(
            JSON.stringify(
              (
                await f.backend.listStepAttempts({
                  workflowRunId: handle.workflowRun.id,
                })
              ).data,
            ),
          ).not.toContain(fixtureToken)
          const result = await handle
            .result({ timeoutMs: 20_000 })
            .catch(async (error) => {
              const attempts = (
                await f.backend.listStepAttempts({
                  workflowRunId: handle.workflowRun.id,
                })
              ).data
              throw new Error(
                JSON.stringify({
                  error: String(error),
                  attempts: attempts.map((attempt) => ({
                    name: attempt.stepName,
                    status: attempt.status,
                    error: attempt.error,
                  })),
                }),
              )
            })
          expect(result).toEqual(
            mode === "full"
              ? {
                  status: "completed",
                  resourcesProcessed: 0,
                  resourcesFailed: 0,
                  commitShas: [
                    f.git("--git-dir", f.remote, "rev-parse", "main"),
                  ],
                  errors: [],
                }
              : { written: 0, deleted: 1, errors: [] },
          )
          expect(
            await getNotionBindingWithRepoByConnectionId(
              f.org.id,
              connectionId,
            ),
          ).toMatchObject({ setupPhase: "live" })
          const runs = (await f.backend.listWorkflowRuns({ limit: 100 })).data
          const children = runs.filter(
            (run) => run.workflowName === "workspace-write-connector-mirror",
          )
          expect(children).toHaveLength(1)
          expect(children[0]).toMatchObject({
            status: "completed",
            input: {
              mirror: {
                provider: "notion",
                connectionId,
                repositoryId: repo.id,
              },
              deletePaths: ["notion/pages/obsolete--page-one/index.md"],
            },
          })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "main",
            ),
          ).toBe("knowledge/owner.md\nnotion/config.yaml")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("1")
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/config.yaml"),
          ).toBe(config.trim())
          for (const run of runs) {
            expect(JSON.stringify(run.input)).not.toContain(fixtureToken)
            expect(
              JSON.stringify(
                (await f.backend.listStepAttempts({ workflowRunId: run.id }))
                  .data,
              ),
            ).not.toContain(fixtureToken)
          }
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 100 }))
            .data) {
            if (!["completed", "failed", "canceled"].includes(run.status))
              await f.runner.cancelWorkflowRun(run.id)
          }
          await worker.stop()
        }
      },
    )
  },
)
