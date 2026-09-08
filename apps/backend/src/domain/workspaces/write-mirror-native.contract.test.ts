import { execFileSync } from "node:child_process"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it(
  "commits a bound connector's Markdown, binary asset and deletion once without changing its config",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "notion/config.yaml", body: "version: 1\n" },
          { path: "notion/obsolete.md", body: "# Removed page\n" },
          { path: "knowledge/owner.md", body: "# Owner knowledge\n" },
        ],
      },
      async (f) => {
        const mirror = await createNotionMirrorBinding(f)
        const jobId = `wjob_${f.id}_mirror`
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId,
          kind: "connector_mirror" as const,
          mirror,
          mergeFiles: [
            {
              path: "notion/page/index.md",
              content: "# Provider page\n![Asset](asset.png)\n",
            },
            {
              path: "notion/page/asset.png",
              content: "iVBORw0KGgoA/w==",
              encoding: "base64" as const,
            },
          ],
          mergeDeletePaths: ["notion/obsolete.md"],
        }
        for (const [index, file] of [
          { path: "notion/config.yaml", content: "version: 2" },
          { path: "knowledge/owner.md", content: "replaced" },
          { path: "notion/../knowledge/owner.md", content: "replaced" },
          {
            path: "notion/bad.png",
            content: "not base64!",
            encoding: "base64" as const,
          },
        ].entries()) {
          const invalidId = `${jobId}_invalid_${index}`
          const errors: Error[] = []
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  ...command,
                  jobId: invalidId,
                  mergeFiles: [file],
                  mergeDeletePaths: [],
                },
                { error: (error) => errors.push(error) },
              ),
            ),
          ).toEqual({ started: false })
          expect(errors).toHaveLength(1)
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(invalidId),
            ),
          ).toBeNull()
        }
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        try {
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(command, {
                error: (error) => {
                  throw error
                },
              }),
            ),
          ).toEqual({ started: true })
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.find(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toMatchObject({
            workflowName: "workspace-write-connector-mirror",
            input: { mirror: command.mirror, files: command.mergeFiles },
          })
          const {
            workspaceConnectorMirror,
            workspaceConnectorMirrorInputSchema,
          } = await import(
            "../../openworkflow/workflows/workspace-connector-mirror.js"
          )
          runner.implementWorkflow(
            workspaceConnectorMirror.spec,
            workspaceConnectorMirror.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(jobId),
                ),
              { timeout: 25_000 },
            )
            .toMatchObject({ status: "completed" })
          expect(
            execFileSync("git", [
              "--git-dir",
              f.remote,
              "show",
              "main:notion/page/asset.png",
            ]).toString("hex"),
          ).toBe("89504e470d0a1a0a00ff")
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/page/index.md"),
          ).toBe("# Provider page\n![Asset](asset.png)")
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/config.yaml"),
          ).toBe("version: 1")
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
            "knowledge/owner.md\nnotion/config.yaml\nnotion/page/asset.png\nnotion/page/index.md",
          )
          const replay = await runner.runWorkflow(
            workspaceConnectorMirror.spec,
            workspaceConnectorMirrorInputSchema.parse(queued?.input),
          )
          expect(await replay.result({ timeoutMs: 15_000 })).toMatchObject({
            committed: true,
          })
          const unchanged = await runner.runWorkflow(
            workspaceConnectorMirror.spec,
            {
              ...workspaceConnectorMirrorInputSchema.parse(queued?.input),
              jobId: `${jobId}_unchanged`,
              revision: {
                ...(await f.resolveRevision()),
                access: "write-default",
              },
            },
          )
          expect(await unchanged.result({ timeoutMs: 15_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
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
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)

async function createNotionMirrorBinding(f: NativeHydrationFixture) {
  const sourceId = `con_${f.id}_notion`
  const repo = await withOrgIdContext(f.org, () =>
    ensureOrgRepositoryForGitUrl({
      orgId: f.org.id,
      gitUrl: f.workspaceUrl,
      githubConnectionId: f.connectionId,
    }),
  )
  if (!repo) throw new Error("Fixture repository unavailable")
  await withOrgDbContext(f.org.id, (db) =>
    db.insert(connections).values({
      id: sourceId,
      orgId: f.org.id,
      type: "notion",
      config: {
        workspaceId: "provider-workspace",
        repositoryId: repo.id,
        branch: "main",
        enabled: true,
        setupPhase: "live",
      },
    }),
  )
  return {
    provider: "notion" as const,
    connectionId: sourceId,
    repositoryId: repo.id,
  }
}

it(
  "rejects a connector reset during credential issuance before publishing any files",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const mirror = await createNotionMirrorBinding(f)
        const { resetNotionConnectorAfterMissingConfig } = await import(
          "../../models/notion-connector.js"
        )
        const { workspaceConnectorMirror } = await import(
          "../../openworkflow/workflows/workspace-connector-mirror.js"
        )
        const spec = {
          ...workspaceConnectorMirror.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceConnectorMirror.fn)
        f.onWriteCredentialRequest(() =>
          resetNotionConnectorAfterMissingConfig({
            orgId: f.org.id,
            connectionId: mirror.connectionId,
          }),
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_mirror_reset`,
            revision: { ...f.revision, access: "write-default" },
            mirror,
            files: [{ path: "notion/page.md", content: "# Provider page\n" }],
            deletePaths: [],
          })
          await expect(handle.result({ timeoutMs: 30_000 })).rejects.toThrow()
          const run = await f.backend.getWorkflowRun({
            workflowRunId: handle.workflowRun.id,
          })
          expect(run?.status).toBe("failed")
          expect(run?.error?.message).toContain(
            "Connector mirror binding changed",
          )
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
