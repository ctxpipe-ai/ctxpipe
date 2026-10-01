import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { encodePagerdutyTokensForDb } from "../../lib/connection-config.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { getPagerdutyBindingWithRepoByConnectionId } from "../../models/pagerduty-connector.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { pagerdutySyncContent } from "../../openworkflow/workflows/pagerduty-sync-content.js"
import { pagerdutySyncEntity } from "../../openworkflow/workflows/pagerduty-sync-entity.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

const PAGERDUTY_CONFIG = `version: 1
source: pagerduty
account:
  id: provider-account
  name: Fixture
  subdomain: fixture
  region: us
scope:
  services:
    - id: PSERVICE
      name: checkout
`

it.each(["entity", "full", "no_workspace", "read_only", "not_live"] as const)(
  "publishes PagerDuty %s through workspace capture and the native mirror child",
  { timeout: 45_000 },
  async (mode) => {
    await withNativeHydrationFixture(
      {
        namespaceId: "default",
        github: true,
        githubWriteView: mode === "read_only" ? "missing" : "writable",
        writeStatus: mode === "read_only" ? "read_only" : "writable",
        githubContentFiles: { "pagerduty/config.yaml": PAGERDUTY_CONFIG },
        pagerdutyResponses:
          mode === "full"
            ? { "/incidents": { body: { incidents: [], more: false } } }
            : undefined,
        files: [
          { path: "pagerduty/config.yaml", body: PAGERDUTY_CONFIG },
          {
            path: "pagerduty/incidents/1--PINCIDENT.md",
            body: "# Deleted incident\n",
          },
          { path: "knowledge/owner.md", body: "# Owner text\n" },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const workspaceRepo = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!workspaceRepo) throw new Error("Fixture repository missing")
        const destRepo =
          mode === "no_workspace"
            ? await withOrgIdContext(f.org, () =>
                ensureOrgRepositoryForGitUrl({
                  orgId: f.org.id,
                  gitUrl: "https://github.com/fixture/unbound-dest.git",
                  githubConnectionId: f.connectionId,
                }),
              )
            : workspaceRepo
        if (!destRepo) throw new Error("Dest repository missing")
        const connectionId = `con_${f.id}_pagerduty`
        const fixtureToken = "native-pagerduty-fixture-token"
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "pagerduty",
              config: {
                ...encodePagerdutyTokensForDb(
                  { accessToken: fixtureToken, refreshToken: null },
                  parseEnv(process.env),
                ),
                accountId: "provider-account",
                accountName: "Fixture",
                accountSubdomain: "fixture",
                region: "us",
                ownerUserId: "fixture-owner",
                status: "installed",
                repositoryId: destRepo.id,
                branch: "main",
                enabled: true,
                setupPhase:
                  mode === "full"
                    ? "initial_sync"
                    : mode === "not_live"
                      ? "initial_sync"
                      : "live",
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        f.runner.implementWorkflow(
          pagerdutySyncContent.spec,
          pagerdutySyncContent.fn,
        )
        f.runner.implementWorkflow(
          pagerdutySyncEntity.spec,
          pagerdutySyncEntity.fn,
        )
        f.runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        const handle =
          mode === "full"
            ? await f.runner.runWorkflow(pagerdutySyncContent.spec, {
                orgId: f.org.id,
                connectionId,
              })
            : await f.runner.runWorkflow(pagerdutySyncEntity.spec, {
                orgId: f.org.id,
                connectionId,
                incidentId: "PINCIDENT",
              })
        try {
          await worker.start()
          if (mode === "no_workspace") {
            await expect(handle.result({ timeoutMs: 20_000 })).rejects.toThrow(
              /Connector target has no Workspace/,
            )
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            expect(
              (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
                (run) =>
                  run.workflowName === "workspace-write-connector-mirror",
              ),
            ).toHaveLength(0)
            return
          }
          if (mode === "read_only") {
            await expect
              .poll(
                () =>
                  withOrgIdContext(f.org, () =>
                    reconcileWorkspaceWriteJob(
                      `wjob_${handle.workflowRun.id}_mirror`,
                    ),
                  ),
                { timeout: 20_000 },
              )
              .toMatchObject({ status: "paused" })
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            return
          }
          if (mode === "not_live") {
            await expect(handle.result({ timeoutMs: 20_000 })).resolves.toEqual(
              {
                written: 0,
                deleted: 0,
                errors: [],
              },
            )
            expect(
              (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
                (run) =>
                  run.workflowName === "workspace-write-connector-mirror",
              ),
            ).toHaveLength(0)
            return
          }

          const result = await handle.result({ timeoutMs: 20_000 })
          expect(result).toMatchObject({
            written: 0,
            deleted: 1,
            errors: [],
            ...(mode === "full"
              ? {
                  status: "completed",
                  resourcesProcessed: 0,
                  resourcesFailed: 0,
                }
              : {}),
          })
          expect(
            await getPagerdutyBindingWithRepoByConnectionId(
              f.org.id,
              connectionId,
            ),
          ).toMatchObject({
            setupPhase: "live",
            repositoryId: workspaceRepo.id,
          })
          const children = (
            await f.backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) => run.workflowName === "workspace-write-connector-mirror",
          )
          expect(children).toHaveLength(1)
          expect(children[0]).toMatchObject({
            status: "completed",
            input: {
              mirror: {
                provider: "pagerduty",
                connectionId,
                repositoryId: workspaceRepo.id,
              },
              deletePaths: ["pagerduty/incidents/1--PINCIDENT.md"],
            },
          })
          expect(
            (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) => run.workflowName === "repository-ingestion-orchestrator",
            ),
          ).toHaveLength(0)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "main",
            ),
          ).toBe("knowledge/owner.md\npagerduty/config.yaml")
          expect(
            JSON.stringify(
              (
                await f.backend.listStepAttempts({
                  workflowRunId: handle.workflowRun.id,
                })
              ).data,
            ),
          ).not.toContain(fixtureToken)
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
