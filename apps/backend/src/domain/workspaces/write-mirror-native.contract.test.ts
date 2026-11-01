import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { invalidateGithubAppCacheForConnection } from "../../models/github-installation.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { cancelWorkflowRunIfOpen } from "../../test/open-workflow-runs.js"
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
        const { getNotionBindingWithRepoByConnectionId } =
          await import("../../models/notion-connector.js")
        expect(
          await getNotionBindingWithRepoByConnectionId(
            f.org.id,
            mirror.connectionId,
          ),
        ).toMatchObject({
          repositoryId: mirror.repositoryId,
          repositoryGitUrl: "https://github.com/fixture/hydration-contract",
          githubConnectionId: f.connectionId,
        })
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
          namespaceId: openWorkflowNamespaceId(),
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
          } =
            await import("../../openworkflow/workflows/workspace-connector-mirror.js")
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
    configBlobSha: f.git(
      "--git-dir",
      f.remote,
      "ls-tree",
      "--name-only",
      f.sha,
      "--",
      "notion/config.yaml",
    )
      ? f.git("--git-dir", f.remote, "rev-parse", `${f.sha}:notion/config.yaml`)
      : null,
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
        const { resetNotionConnectorAfterMissingConfig } =
          await import("../../models/notion-connector.js")
        const { workspaceConnectorMirror } =
          await import("../../openworkflow/workflows/workspace-connector-mirror.js")
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

it(
  "retains a paused mirror's source, binary files and deletions and rejects invalid managed paths",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "read_only" },
      async (f) => {
        const mirror = await createNotionMirrorBinding(f)
        const jobId = `wjob_${f.id}_paused_mirror`
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId,
          kind: "connector_mirror" as const,
          mirror,
          mergeFiles: [
            {
              path: "notion/asset.png",
              content: "iVBORw0KGgoA/w==",
              encoding: "base64" as const,
            },
          ],
          mergeDeletePaths: ["notion/old.md"],
        }
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(command, {
              error: (error) => {
                throw error
              },
            }),
          ),
        ).toEqual({ started: true })
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          ),
        ).toMatchObject({
          status: "paused",
          payload: {
            mirror,
            mergeFiles: command.mergeFiles,
            mergeDeletePaths: command.mergeDeletePaths,
          },
        })
        const invalidId = `${jobId}_invalid`
        const errors: Error[] = []
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                ...command,
                jobId: invalidId,
                mergeFiles: [
                  { path: "notion/config.yaml", content: "replace" },
                ],
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
        const { BackendPostgres } = await import("openworkflow/postgres")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        try {
          expect(
            (await backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) =>
                [jobId, invalidId].includes(
                  (run.input as { jobId?: string })?.jobId ?? "",
                ),
            ),
          ).toMatchObject([
            {
              workflowName: "workspace-write-connector-mirror",
              input: { jobId },
            },
          ])
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it.each([false, true])(
  "retains connector identity when it pushes again after a concurrent commit; reset=%s",
  { timeout: 60_000 },
  async (reset) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "notion/page.md", body: "# Old page\n" },
          { path: "knowledge/owner.md", body: "# Original owner\n" },
        ],
      },
      async (f) => {
        const mirror = await createNotionMirrorBinding(f)
        const { workspaceConnectorMirror } =
          await import("../../openworkflow/workflows/workspace-connector-mirror.js")
        const mirrorSpec = {
          ...workspaceConnectorMirror.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(mirrorSpec, workspaceConnectorMirror.fn)
        const worker = f.runner.newWorker({ concurrency: 1 })
        let humanSha: string | undefined
        f.onWriteCredentialRequest(async () => {
          if (!humanSha) {
            f.git("reset", "--hard", f.sha)
            writeFileSync(
              join(f.directory, "knowledge/owner.md"),
              "# Updated owner\n",
            )
            f.git("add", "knowledge/owner.md")
            f.git("commit", "-m", "Concurrent owner update")
            f.git("push", f.remote, "HEAD:main")
            humanSha = f.git("rev-parse", "HEAD")
          }
          if (reset) {
            const { resetNotionConnectorAfterMissingConfig } =
              await import("../../models/notion-connector.js")
            await resetNotionConnectorAfterMissingConfig({
              orgId: f.org.id,
              connectionId: mirror.connectionId,
            })
          }
        })
        try {
          await worker.start()
          const handle = await f.runner.runWorkflow(mirrorSpec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_handoff`,
            revision: { ...f.revision, access: "write-default" },
            mirror,
            files: [{ path: "notion/page.md", content: "# Updated page\n" }],
            deletePaths: [],
          })
          if (reset)
            await expect(handle.result({ timeoutMs: 30_000 })).rejects.toThrow()
          else
            expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
              committed: true,
            })
          const children = (
            await f.backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) => run.workflowName === "workspace-write-semantic-merge",
          )
          expect(children).toHaveLength(0)
          if (reset) {
            const parent = await f.backend.getWorkflowRun({
              workflowRunId: handle.workflowRun.id,
            })
            expect(parent?.error?.message).toContain(
              "Connector mirror binding changed",
            )
          }
          expect(
            f.git("--git-dir", f.remote, "show", "main:knowledge/owner.md"),
          ).toBe("# Updated owner")
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/page.md"),
          ).toBe(reset ? "# Old page" : "# Updated page")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${humanSha}..main`,
            ),
          ).toBe(reset ? "0" : "1")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "rejects a slow mirror captured before a newer config and mirror commit",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "notion/config.yaml", body: "version: 1\nresources: []\n" },
          { path: "notion/page.md", body: "# Original page\n" },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const mirror = await createNotionMirrorBinding(f)
        const { captureConnectorMirrorTarget } =
          await import("./capture-connector-mirror.js")
        const { parseEnv } = await import("../../config/env.js")
        const captured = await captureConnectorMirrorTarget({
          orgId: f.org.id,
          env: parseEnv(process.env),
          repositoryGitUrl: f.workspaceUrl,
          mirror,
        })
        const { workspaceConnectorMirror } =
          await import("../../openworkflow/workflows/workspace-connector-mirror.js")
        const spec = {
          ...workspaceConnectorMirror.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceConnectorMirror.fn)
        f.git("reset", "--hard", f.sha)
        writeFileSync(
          join(f.directory, "notion/config.yaml"),
          "version: 1\nresources:\n  - id: new-page\n    type: page\n",
        )
        f.git("add", "notion/config.yaml")
        f.git("commit", "-m", "Activate newer scope")
        f.git("push", f.remote, "HEAD:main")
        const newer = await captureConnectorMirrorTarget({
          orgId: f.org.id,
          env: parseEnv(process.env),
          repositoryGitUrl: f.workspaceUrl,
          mirror,
        })
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const current = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: newer.revision,
            mirror: newer.mirror,
            jobId: `wjob_${f.id}_new_scope`,
            files: [{ path: "notion/page.md", content: "# New scope page\n" }],
            deletePaths: [],
          })
          expect(await current.result({ timeoutMs: 15_000 })).toMatchObject({
            committed: true,
          })
          const newTip = f.git("--git-dir", f.remote, "rev-parse", "main")
          const stale = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: captured.revision,
            mirror: captured.mirror,
            jobId: `wjob_${f.id}_old_scope`,
            files: [],
            deletePaths: ["notion/page.md"],
          })
          await expect(stale.result({ timeoutMs: 20_000 })).rejects.toThrow()
          expect(
            (
              await f.backend.getWorkflowRun({
                workflowRunId: stale.workflowRun.id,
              })
            )?.error?.message,
          ).toContain("Connector scope changed")
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(newTip)
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/page.md"),
          ).toBe("# New scope page")
          expect(
            (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) => run.workflowName === "workspace-write-semantic-merge",
            ),
          ).toHaveLength(0)
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 100 }))
            .data)
            if (!["completed", "failed", "canceled"].includes(run.status))
              await cancelWorkflowRunIfOpen(f.backend, run.id)
          await worker.stop()
        }
      },
    )
  },
)

/** A Notion page mirror file with the source update time of a snapshot. */
const notionPage = (lastEditedTime: string, title: string) =>
  `---\nsource: notion\nlast_edited_time: "${lastEditedTime}"\n---\n# ${title}\n`

it.each([
  {
    name: "an older snapshot keeps the newer file on the moved tip",
    race: true,
    tip: notionPage("2026-10-30T12:00:00.000Z", "Newer page"),
    incoming: notionPage("2026-10-30T11:00:00.000Z", "Older page"),
    result: { committed: false, reason: "no_changes" },
    page: "Newer page",
  },
  {
    name: "an older snapshot that starts on the newer tip keeps the newer file",
    race: false,
    tip: notionPage("2026-10-30T12:00:00.000Z", "Newer page"),
    incoming: notionPage("2026-10-30T11:00:00.000Z", "Older page"),
    result: { committed: false, reason: "no_changes" },
    page: "Newer page",
  },
  {
    name: "a snapshot with the same update time replaces the file on the moved tip",
    race: true,
    tip: notionPage("2026-10-30T12:00:00.000Z", "Page before the comment"),
    incoming: notionPage("2026-10-30T12:00:00.000Z", "Page with the comment"),
    result: { committed: true },
    page: "Page with the comment",
  },
  {
    name: "a newer snapshot replaces the older file on the moved tip",
    race: true,
    tip: notionPage("2026-10-30T11:00:00.000Z", "Older page"),
    incoming: notionPage("2026-10-30T12:00:00.000Z", "Newer page"),
    result: { committed: true },
    page: "Newer page",
  },
  {
    name: "an older snapshot replaces a file with conflict markers on the moved tip",
    race: true,
    tip: [
      "---",
      "source: notion",
      'last_edited_time: "2026-10-30T12:00:00.000Z"',
      "---",
      "# Merged page",
      "<<<<<<< ours",
      "Newer text",
      "=======",
      "Older text",
      ">>>>>>> theirs",
      "",
    ].join("\n"),
    incoming: notionPage("2026-10-30T11:00:00.000Z", "Older page"),
    result: { committed: true },
    page: "Older page",
  },
])(
  "writes a connector mirror with no semantic merge: $name",
  { timeout: 60_000 },
  async ({ race, tip, incoming, result, page }) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "notion/config.yaml", body: "version: 1\n" },
          {
            path: "notion/page.md",
            body: notionPage("2026-10-30T09:00:00.000Z", "Original page"),
          },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const mirror = await createNotionMirrorBinding(f)
        const { workspaceConnectorMirror } =
          await import("../../openworkflow/workflows/workspace-connector-mirror.js")
        const spec = {
          ...workspaceConnectorMirror.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceConnectorMirror.fn)
        // Another mirror write of the same page pushes first.
        f.git("reset", "--hard", f.sha)
        writeFileSync(join(f.directory, "notion/page.md"), tip)
        f.git("add", "notion/page.md")
        f.git("commit", "-m", "Concurrent mirror write")
        f.git("push", f.remote, "HEAD:main")
        const movedTip = f.git("rev-parse", "HEAD")
        // With a race, the write has the revision from before the concurrent
        // push. With no race, the write starts on the moved tip.
        const target = race
          ? {
              revision: { ...f.revision, access: "write-default" as const },
              mirror,
            }
          : await captureMirrorTarget(f, mirror).then((captured) => ({
              revision: captured.revision,
              mirror: captured.mirror,
            }))
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const write = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            ...target,
            jobId: `wjob_${f.id}_snapshot`,
            files: [{ path: "notion/page.md", content: incoming }],
            deletePaths: [],
          })
          expect(await write.result({ timeoutMs: 30_000 })).toMatchObject(
            result,
          )
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/page.md"),
          ).toContain(`# ${page}`)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${movedTip}..main`,
            ),
          ).toBe(result.committed ? "1" : "0")
          await expectNoSemanticMerge(f)
        } finally {
          await stopOpenRuns(f)
          await worker.stop()
        }
      },
    )
  },
)

it(
  "fails the connector mirror job with no semantic merge when the tip moves at each attempt",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "notion/config.yaml", body: "version: 1\n" },
          { path: "notion/page.md", body: "# Original page\n" },
          { path: "knowledge/moves.md", body: "0\n" },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const mirror = await createNotionMirrorBinding(f)
        const { workspaceConnectorMirror } =
          await import("../../openworkflow/workflows/workspace-connector-mirror.js")
        const spec = {
          ...workspaceConnectorMirror.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceConnectorMirror.fn)
        // Another writer pushes before each push of the mirror write. The
        // cache drop makes each push ask for a new write credential.
        let moves = 0
        f.git("reset", "--hard", f.sha)
        f.onWriteCredentialRequest(async () => {
          moves++
          writeFileSync(join(f.directory, "knowledge/moves.md"), `${moves}\n`)
          f.git("add", "knowledge/moves.md")
          f.git("commit", "-m", `Concurrent write ${moves}`)
          f.git("push", f.remote, "HEAD:main")
          invalidateGithubAppCacheForConnection(f.connectionId)
        })
        const worker = f.runner.newWorker({ concurrency: 1 })
        const jobId = `wjob_${f.id}_moving_tip`
        try {
          await worker.start()
          const write = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: { ...f.revision, access: "write-default" },
            mirror,
            jobId,
            files: [{ path: "notion/page.md", content: "# Updated page\n" }],
            deletePaths: [],
          })
          await expect(write.result({ timeoutMs: 60_000 })).rejects.toThrow()
          expect(
            (
              await f.backend.getWorkflowRun({
                workflowRunId: write.workflowRun.id,
              })
            )?.error?.message,
          ).toContain("The default branch moved during each of 5 attempts")
          expect(moves).toBe(5)
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(jobId),
            ),
          ).toMatchObject({
            status: "failed",
            commitSha: null,
            payload: {
              failureReason: expect.stringContaining(
                "The default branch moved during each of 5 attempts",
              ),
            },
          })
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/page.md"),
          ).toBe("# Original page")
          await expectNoSemanticMerge(f)
        } finally {
          await stopOpenRuns(f)
          await worker.stop()
        }
      },
    )
  },
)

/** The revision and binding of a mirror write that starts on the tip now. */
async function captureMirrorTarget(
  f: NativeHydrationFixture,
  mirror: Awaited<ReturnType<typeof createNotionMirrorBinding>>,
) {
  const { captureConnectorMirrorTarget } =
    await import("./capture-connector-mirror.js")
  const { parseEnv } = await import("../../config/env.js")
  return captureConnectorMirrorTarget({
    orgId: f.org.id,
    env: parseEnv(process.env),
    repositoryGitUrl: f.workspaceUrl,
    mirror,
  })
}

/**
 * The worker does not run the semantic merge workflow. A queued merge run
 * is still in the run list, and a model request still reaches the fixture.
 */
async function expectNoSemanticMerge(f: NativeHydrationFixture) {
  expect(
    (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
      (run) => run.workflowName === "workspace-write-semantic-merge",
    ),
  ).toHaveLength(0)
  expect(f.semanticRequests).toHaveLength(0)
}

async function stopOpenRuns(f: NativeHydrationFixture) {
  for (const run of (await f.backend.listWorkflowRuns({ limit: 100 })).data)
    if (!["completed", "failed", "canceled"].includes(run.status))
      await cancelWorkflowRunIfOpen(f.backend, run.id)
}
