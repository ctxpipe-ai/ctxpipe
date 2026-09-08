import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { confluenceSyncTargets } from "../../db/schema/confluenceSyncTargets.js"
import { connections } from "../../db/schema/connections.js"
import { getConfluenceSyncTargetWithRepoByConnectionId } from "../../models/confluence-sync-target.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { confluenceSyncContent } from "../../openworkflow/workflows/confluence-sync-content.js"
import { confluenceSyncSpace } from "../../openworkflow/workflows/confluence-sync-space.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it.each(["full", "space", "failed"] as const)(
  "captures Confluence %s with scoped deletion and transient credentials",
  { timeout: 45_000 },
  async (mode) => {
    const config =
      mode === "failed"
        ? "version: 1\nsource: confluence\nspaces:\n  - key: ENG\n    selectedPageIds: null\n"
        : "version: 1\nsource: confluence\nspaces: []\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        githubContentFiles: { "confluence/config.yaml": config },
        confluenceResponses: {
          "wiki/api/v2/spaces": {
            body: {
              results:
                mode === "failed"
                  ? [{ id: "1", key: "ENG", name: "Engineering" }]
                  : [],
            },
          },
          "wiki/api/v2/pages": {
            body: { results: [{ id: "42", title: "Broken", spaceId: "1" }] },
          },
          "wiki/api/v2/pages/42": {
            status: 403,
            body: { message: "Forbidden" },
          },
        },
        files: [
          { path: "confluence/config.yaml", body: config },
          {
            path: "confluence/ENG/obsolete--page-one.md",
            body: "# Deleted issue\n",
          },
          { path: "confluence/OPS/keep.md", body: "# Other space\n" },
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
        const connectionId = `con_${f.id}_confluence`
        const fixtureToken = "native-confluence-fixture-token"
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "forge",
              config: {
                cloudId: "fixture-cloud",
                appSystemToken: fixtureToken,
                workspaceId: "provider-workspace",
                workspaceName: "Fixture",
                ownerUserId: "fixture-owner",
                status: "installed",
                repositoryId: repo.id,
                branch: "main",
                enabled: true,
                setupPhase: mode === "space" ? "live" : "initial_sync",
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        f.runner.implementWorkflow(
          confluenceSyncContent.spec,
          confluenceSyncContent.fn,
        )
        f.runner.implementWorkflow(
          confluenceSyncSpace.spec,
          confluenceSyncSpace.fn,
        )
        f.runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(confluenceSyncTargets).values({
            id: `cst_${f.id}`,
            orgId: f.org.id,
            connectionId,
            repositoryId: repo.id,
            branch: "main",
            enabled: true,
            setupPhase: mode === "space" ? "live" : "initial_sync",
          }),
        )
        const handle =
          mode === "space"
            ? await f.runner.runWorkflow(confluenceSyncSpace.spec, {
                orgId: f.org.id,
                connectionId,
                spaceKey: "ENG",
              })
            : await f.runner.runWorkflow(confluenceSyncContent.spec, {
                orgId: f.org.id,
                orgSlug: f.org.slug,
                connectionId,
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
          expect(result).toMatchObject({
            status: mode === "failed" ? "failed" : "completed",
            spacesProcessed: mode === "failed" ? 1 : 0,
            pagesProcessed: 0,
            pagesFailed: mode === "failed" ? 1 : 0,
          })
          if (mode === "space")
            expect(result).toMatchObject({
              commitSha: f.git("--git-dir", f.remote, "rev-parse", "main"),
              spaceKey: "ENG",
            })
          else
            expect(result).toMatchObject({
              commitShas:
                mode === "failed"
                  ? []
                  : [f.git("--git-dir", f.remote, "rev-parse", "main")],
            })
          expect(
            await getConfluenceSyncTargetWithRepoByConnectionId(
              f.org.id,
              connectionId,
            ),
          ).toMatchObject({
            setupPhase: mode === "failed" ? "sync_failed" : "live",
          })
          const runs = (await f.backend.listWorkflowRuns({ limit: 100 })).data
          const children = runs.filter(
            (run) => run.workflowName === "workspace-write-connector-mirror",
          )
          expect(children).toHaveLength(mode === "failed" ? 0 : 1)
          if (mode !== "failed")
            expect(children[0]).toMatchObject({
              status: "completed",
              input: {
                mirror: {
                  provider: "confluence",
                  connectionId,
                  repositoryId: repo.id,
                },
                deletePaths:
                  mode === "full"
                    ? [
                        "confluence/ENG/obsolete--page-one.md",
                        "confluence/OPS/keep.md",
                      ]
                    : ["confluence/ENG/obsolete--page-one.md"],
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
          ).toBe(
            mode === "failed"
              ? "confluence/ENG/obsolete--page-one.md\nconfluence/OPS/keep.md\nconfluence/config.yaml\nknowledge/owner.md"
              : mode === "space"
                ? "confluence/OPS/keep.md\nconfluence/config.yaml\nknowledge/owner.md"
                : "confluence/config.yaml\nknowledge/owner.md",
          )
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe(mode === "failed" ? "0" : "1")
          expect(
            f.git("--git-dir", f.remote, "show", "main:confluence/config.yaml"),
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
          await withOrgDbContext(f.org.id, (db) =>
            db
              .delete(confluenceSyncTargets)
              .where(eq(confluenceSyncTargets.connectionId, connectionId)),
          )
        }
      },
    )
  },
)
