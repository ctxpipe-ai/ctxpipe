import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { encodeLinearTokensForDb } from "../../lib/connection-config.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { getLinearBindingWithRepoByConnectionId } from "../../models/linear-connector.js"
import { linearSyncContent } from "../../openworkflow/workflows/linear-sync-content.js"
import { linearSyncEntity } from "../../openworkflow/workflows/linear-sync-entity.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it.each(["entity", "full", "rebind"] as const)(
  "captures a Linear %s deletion without persisting its credential and runs one native mirror child",
  { timeout: 45_000 },
  async (mode) => {
    const config =
      "version: 1\nsource: linear\nworkspace:\n  id: provider-workspace\n  name: Fixture\nscope: {}\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        githubContentFiles: { "linear/config.yaml": config },
        files: [
          { path: "linear/config.yaml", body: config },
          {
            path: "linear/issues/obsolete--issue-one.md",
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
        const connectionId = `con_${f.id}_linear`
        const fixtureToken = "native-linear-fixture-token"
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "linear",
              config: {
                ...encodeLinearTokensForDb(
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
                setupPhase: mode !== "entity" ? "initial_sync" : "live",
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        f.runner.implementWorkflow(linearSyncContent.spec, linearSyncContent.fn)
        f.runner.implementWorkflow(linearSyncEntity.spec, linearSyncEntity.fn)
        f.runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const priorPath = process.env.PATH
        const pushed = join(f.directory, "mirror-pushed")
        const release = join(f.directory, "mirror-rebound")
        if (mode === "rebind") {
          const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
            encoding: "utf8",
          }).trim()
          const bin = join(f.directory, "push-pause-bin")
          mkdirSync(bin)
          writeFileSync(
            join(bin, "git"),
            `#!${process.execPath}
const {spawnSync} = require("node:child_process");
const {existsSync, writeFileSync} = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio: "inherit"});
if (result.status === 0 && args.includes("push")) {
  writeFileSync(${JSON.stringify(pushed)}, "pushed");
  const deadline = Date.now() + 15000;
  while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
process.exit(result.status ?? 1);
`,
            { mode: 0o700 },
          )
          process.env.PATH = `${bin}:${priorPath}`
        }
        const worker = f.runner.newWorker({ concurrency: 1 })
        const handle =
          mode !== "entity"
            ? await f.runner.runWorkflow(linearSyncContent.spec, {
                contentSyncGeneration: 0,
                orgId: f.org.id,
                connectionId,
              })
            : await f.runner.runWorkflow(linearSyncEntity.spec, {
                orgId: f.org.id,
                connectionId,
                entityType: "issue",
                externalId: "issue-one",
                action: "delete",
              })
        try {
          await worker.start()
          if (mode === "rebind") {
            await expect
              .poll(() => existsSync(pushed), { timeout: 15_000 })
              .toBe(true)
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(connections)
                .set({
                  config: sql`${connections.config} || ${JSON.stringify({ branch: "next", setupPhase: "initial_sync" })}::jsonb`,
                })
                .where(eq(connections.id, connectionId)),
            )
            writeFileSync(release, "release")
          }

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
          expect(result).toEqual({
            ...(mode !== "entity" ? { status: "completed" } : {}),
            written: 0,
            deleted: 1,
            failures: [],
          })
          expect(
            await getLinearBindingWithRepoByConnectionId(
              f.org.id,
              connectionId,
            ),
          ).toMatchObject({
            setupPhase: mode === "rebind" ? "initial_sync" : "live",
            branch: mode === "rebind" ? "next" : "main",
          })
          const runs = (await f.backend.listWorkflowRuns({ limit: 100 })).data
          const children = runs.filter(
            (run) => run.workflowName === "workspace-write-connector-mirror",
          )
          expect(children).toHaveLength(1)
          expect(children[0]).toMatchObject({
            status: "completed",
            input: {
              mirror: {
                provider: "linear",
                connectionId,
                repositoryId: repo.id,
              },
              deletePaths: ["linear/issues/obsolete--issue-one.md"],
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
          ).toBe("knowledge/owner.md\nlinear/config.yaml")
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
            f.git("--git-dir", f.remote, "show", "main:linear/config.yaml"),
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
          writeFileSync(release, "release")
          process.env.PATH = priorPath
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
