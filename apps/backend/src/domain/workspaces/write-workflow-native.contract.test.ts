import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import {
  detachWorkspaceConnection,
  getDesiredWorkspaceRevision,
  getWriteJobCommitSha,
} from "../../models/workspaces.js"
import { workspaceBootstrap } from "../../openworkflow/workflows/workspace-bootstrap.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"

it(
  "bootstraps a workspace in one native commit with a durable job result",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const spec = {
          ...workspaceBootstrap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
        await f.publish()
        await f.worker.stop()
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const jobId = `wjob_${f.id}`
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision: { ...f.revision, access: "write-default" },
          })
          const result = await handle
            .result({ timeoutMs: 30_000 })
            .catch(async (error) => {
              const steps = await f.backend.listStepAttempts({
                workflowRunId: handle.workflowRun.id,
              })
              throw new Error(
                JSON.stringify({
                  error: String(error),
                  steps: steps.data.map((s) => ({
                    name: s.stepName,
                    status: s.status,
                    error: s.error,
                  })),
                }),
              )
            })
          expect(result).toMatchObject({ committed: true })
          const tip = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..${tip}`,
            ),
          ).toBe("1")
          expect(
            f.git("--git-dir", f.remote, "show", `${tip}:AGENTS.md`),
          ).toContain("name: Hydration contract")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              `${tip}:.agents/skills/ctxpipe-knowledge/SKILL.md`,
            ),
          ).toContain("# ctxpipe knowledge")
          expect(
            f.git("--git-dir", f.remote, "show", `${tip}:document-000.md`),
          ).toBe("# Document 0\nCommitted body 0.")
          expect(
            await withOrgIdContext(f.org, () => getWriteJobCommitSha(jobId)),
          ).toBe(tip)
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "replays an already published bootstrap job without a second commit",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const spec = {
          ...workspaceBootstrap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
        await f.publish()
        await f.worker.stop()
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const input = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}`,
            revision: { ...f.revision, access: "write-default" as const },
          }
          const first = await f.runner.runWorkflow(spec, input)
          expect(await first.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: true,
          })
          const tip = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          const replay = await f.runner.runWorkflow(spec, input)
          expect(await replay.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: true,
            commitSha: tip,
          })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("1")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "replays a completed no-op without creating a commit",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const spec = {
          ...workspaceBootstrap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
        await f.publish()
        await f.worker.stop()
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const first = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}`,
            revision: { ...f.revision, access: "write-default" },
          })
          expect(await first.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: true,
          })
          const tip = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          const revision = await withOrgIdContext(f.org, () =>
            getDesiredWorkspaceRevision(f.workspaceId, "write-default"),
          )
          if (!revision)
            throw new Error("Expected committed workspace revision")
          const input = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_noop`,
            revision,
          }
          const noop = await f.runner.runWorkflow(spec, input)
          expect(await noop.result({ timeoutMs: 30_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          const replay = await f.runner.runWorkflow(spec, input)
          expect(await replay.result({ timeoutMs: 30_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(tip)
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "admits bootstrap through the production queue as a bound typed workflow",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.publish()
        const { enqueueWriteJob } = await import(
          "../../openworkflow/enqueue-workspace-write-commit.js"
        )
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          const jobId = `wjob_${f.id}_admitted`
          const accepted = await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "bootstrap",
              },
              {
                error: (error) => {
                  throw error
                },
              },
            ),
          )
          expect(accepted).toEqual({ started: true })
          const commands = await backend.listWorkflowRuns({ limit: 100 })
          const queued = commands.data.find(
            (row) => (row.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toMatchObject({
            workflowName: "workspace-write-bootstrap",
            input: {
              revision: {
                workspaceId: f.workspaceId,
                sha: f.sha,
                access: "write-default",
              },
            },
          })
          await worker.start()
          await expect
            .poll(
              async () =>
                withOrgIdContext(
                  f.org,
                  async () => (await getWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          const tip = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          expect(
            f.git("--git-dir", f.remote, "show", `${tip}:AGENTS.md`),
          ).toContain("name: Hydration contract")
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "rejects an unavailable workspace without queuing an unbound write",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const { enqueueWriteJob } = await import(
          "../../openworkflow/enqueue-workspace-write-commit.js"
        )
        const { BackendPostgres } = await import("openworkflow/postgres")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        try {
          const jobId = `wjob_${f.id}_missing`
          const errors: Error[] = []
          const result = await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: `${f.workspaceId}_missing`,
                jobId,
                kind: "bootstrap",
              },
              {
                error: (error) => {
                  errors.push(error)
                },
              },
            ),
          )
          expect(result).toEqual({ started: false })
          const queued = await backend.listWorkflowRuns({ limit: 100 })
          expect(
            queued.data.filter(
              (row) => (row.input as { jobId?: string })?.jobId === jobId,
            ),
          ).toEqual([])
          expect(errors).toHaveLength(1)
        } finally {
          await backend.stop()
        }
      },
    )
  },
)

it(
  "does not push after its connection is detached during credential issuance",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const spec = {
          ...workspaceBootstrap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
        await f.publish()
        await f.worker.stop()
        f.onWriteCredentialRequest(() =>
          withOrgIdContext(f.org, () =>
            detachWorkspaceConnection(f.connectionId),
          ),
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_detach`,
            revision: { ...f.revision, access: "write-default" },
          })
          const [result] = await Promise.allSettled([
            handle.result({ timeoutMs: 30_000 }),
          ])
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
          expect(result?.status).toBe("rejected")
          const run = await f.backend.getWorkflowRun({
            workflowRunId: handle.workflowRun.id,
          })
          expect(run?.status).toBe("failed")
          expect(run?.error?.message).toContain("binding changed")
          expect(
            await withOrgIdContext(f.org, () =>
              getWorkspaceWriteJob(`wjob_${f.id}_detach`),
            ),
          ).toMatchObject({ status: "failed" })
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it.each([false, true])(
  "recovers a lost push acknowledgement when the observed tip has a later commit: %s",
  { timeout: 60_000 },
  async (advanceTip) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const spec = {
          ...workspaceBootstrap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
        await f.publish()
        await f.worker.stop()
        const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
          encoding: "utf8",
        }).trim()
        const bin = join(f.directory, "fault-bin")
        mkdirSync(bin)
        const pushed = join(f.directory, "push-succeeded")
        const observed = join(f.directory, "revision-observed")
        // Every command runs real Git. Lose only the first successful push's acknowledgement.
        writeFileSync(
          join(bin, "git"),
          `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (result.status === 0 && args.includes("push") && !existsSync(${JSON.stringify(pushed)})) {
  writeFileSync(${JSON.stringify(pushed)}, "published");
  const deadline = Date.now() + 10000;
  while (!existsSync(${JSON.stringify(observed)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  process.exit(75);
}
process.exit(result.status ?? 1);
`,
          { mode: 0o700 },
        )
        const priorPath = process.env.PATH
        process.env.PATH = `${bin}:${priorPath}`
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const jobId = `wjob_${f.id}_uncertain`
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision: { ...f.revision, access: "write-default" },
          })
          await expect
            .poll(() => existsSync(pushed), { timeout: 20_000 })
            .toBe(true)
          const publishedSha = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            "refs/heads/main",
          )
          if (advanceTip) {
            const tree = f.git(
              "--git-dir",
              f.remote,
              "rev-parse",
              `${publishedSha}^{tree}`,
            )
            const descendant = f.git(
              "--git-dir",
              f.remote,
              "-c",
              "user.name=Concurrent writer",
              "-c",
              "user.email=fixture@example.test",
              "commit-tree",
              tree,
              "-p",
              publishedSha,
              "-m",
              "Independent subsequent commit",
            )
            f.git(
              "--git-dir",
              f.remote,
              "update-ref",
              "refs/heads/main",
              descendant,
              publishedSha,
            )
          }
          const refreshed = await withOrgIdContext(f.org, () =>
            resolveWorkspaceReadRevision({
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
              refresh: true,
            }),
          )
          expect(refreshed?.revision.sha).not.toBe(f.sha)
          writeFileSync(observed, "observed")
          const result = await handle.result({ timeoutMs: 20_000 })
          expect(result).toMatchObject({
            committed: true,
            commitSha: publishedSha,
          })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe(advanceTip ? "2" : "1")
          expect(
            await withOrgIdContext(f.org, () => getWorkspaceWriteJob(jobId)),
          ).toMatchObject({
            status: "completed",
            commitSha: publishedSha,
          })
          const { BackendPostgres } = await import("openworkflow/postgres")
          const publication = await BackendPostgres.connect(f.databaseUrl, {
            runMigrations: false,
          })
          try {
            const queued = await publication.listWorkflowRuns({ limit: 100 })
            expect(
              queued.data.some((row) => {
                const input = row.input as {
                  workspaceId?: string
                  revision?: { sha?: string }
                }
                return (
                  row.workflowName === "workspace-hydrate" &&
                  input.workspaceId === f.workspaceId &&
                  input.revision?.sha === refreshed?.revision.sha
                )
              }),
            ).toBe(true)
          } finally {
            await publication.stop()
          }
          expect(
            f.tokenRequests.filter(
              (r) =>
                (r as { permissions?: { contents?: string } }).permissions
                  ?.contents === "write",
            ),
          ).toHaveLength(1)
        } finally {
          writeFileSync(observed, "release")
          await worker.stop()
          if (priorPath === undefined) delete process.env.PATH
          else process.env.PATH = priorPath
        }
      },
    )
  },
)

it(
  "publishes a file edit and deletion through one typed native workflow",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        count: 2,
      },
      async (f) => {
        await f.publish()
        const { enqueueWriteJob } = await import(
          "../../openworkflow/enqueue-workspace-write-commit.js"
        )
        const { workspaceFileEdit } = await import(
          "../../openworkflow/workflows/workspace-file-edit.js"
        )
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceFileEdit.spec, workspaceFileEdit.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          const jobId = `wjob_${f.id}_edit`
          const accepted = await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "ui_file_edit",
                mergeFiles: [
                  { path: "knowledge/new.md", content: "# New knowledge\n" },
                ],
                mergeDeletePaths: ["document-001.md"],
              },
              {
                error: (error) => {
                  throw error
                },
              },
            ),
          )
          expect(accepted).toEqual({ started: true })
          const commands = await backend.listWorkflowRuns({ limit: 100 })
          const queued = commands.data.find(
            (row) => (row.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toMatchObject({
            workflowName: "workspace-write-ui-file-edit",
            input: {
              revision: { sha: f.sha, access: "write-default" },
              files: [
                { path: "knowledge/new.md", content: "# New knowledge\n" },
              ],
              deletePaths: ["document-001.md"],
            },
          })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await getWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("1")
          expect(
            f
              .git(
                "--git-dir",
                f.remote,
                "ls-tree",
                "-r",
                "--name-only",
                "refs/heads/main",
              )
              .split("\n"),
          ).toEqual(["document-000.md", "knowledge/new.md"])
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:knowledge/new.md",
            ),
          ).toBe("# New knowledge")
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "does not write the former default branch when the remote changes during credential issuance",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const spec = {
          ...workspaceBootstrap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
        await f.publish()
        await f.worker.stop()
        f.onWriteCredentialRequest(async () => {
          f.git("--git-dir", f.remote, "update-ref", "refs/heads/trunk", f.sha)
          f.git(
            "--git-dir",
            f.remote,
            "symbolic-ref",
            "HEAD",
            "refs/heads/trunk",
          )
        })
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_default`,
            revision: { ...f.revision, access: "write-default" },
          })
          const [result] = await Promise.allSettled([
            handle.result({ timeoutMs: 30_000 }),
          ])
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/trunk"),
          ).toBe(f.sha)
          expect(result?.status).toBe("rejected")
          const run = await f.backend.getWorkflowRun({
            workflowRunId: handle.workflowRun.id,
          })
          expect(run?.status).toBe("failed")
          expect(run?.error?.message).toContain("Default branch changed")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "gives concurrent deliveries of one job a single workflow owner and commit",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const spec = {
          ...workspaceBootstrap.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceBootstrap.fn)
        await f.publish()
        await f.worker.stop()
        const input = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_concurrent`,
          revision: { ...f.revision, access: "write-default" as const },
        }
        const handles = await Promise.all([
          f.runner.runWorkflow(spec, input),
          f.runner.runWorkflow(spec, input),
        ])
        const worker = f.runner.newWorker({ concurrency: 2 })
        await worker.start()
        try {
          const results = await Promise.allSettled(
            handles.map((handle) => handle.result({ timeoutMs: 30_000 })),
          )
          expect(
            results.filter((result) => result.status === "fulfilled"),
          ).not.toHaveLength(0)
          const runs = await Promise.all(
            handles.map((handle) =>
              f.backend.getWorkflowRun({
                workflowRunId: handle.workflowRun.id,
              }),
            ),
          )
          // A replica admitted after completion may return the durable result.
          // A replica racing the active owner is rejected; neither can commit again.
          expect(
            runs.every(
              (run) => run?.status === "completed" || run?.status === "failed",
            ),
          ).toBe(true)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("1")
          const job = await withOrgIdContext(f.org, () =>
            getWorkspaceWriteJob(input.jobId),
          )
          expect(job?.status).toBe("completed")
          const owner = runs.find(
            (run) => run?.id === job?.payload?.workflowRunId,
          )
          expect(owner?.status).toBe("completed")
          for (const result of results) {
            if (result.status === "fulfilled")
              expect(result.value).toEqual({
                committed: true,
                commitSha: job?.commitSha,
              })
          }
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "preserves executable and symlink modes when editing their native Git blobs",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "run.sh", body: "#!/bin/sh\necho before\n", mode: "100755" },
          { path: "current", body: "before.md", mode: "120000" },
        ],
      },
      async (f) => {
        const { workspaceFileEdit } = await import(
          "../../openworkflow/workflows/workspace-file-edit.js"
        )
        const spec = {
          ...workspaceFileEdit.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceFileEdit.fn)
        await f.worker.stop()
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_modes`,
            revision: { ...f.revision, access: "write-default" },
            files: [
              { path: "run.sh", content: "#!/bin/sh\necho after\n" },
              { path: "current", content: "after.md" },
            ],
            deletePaths: [],
          })
          expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: true,
          })
          const entries = f
            .git("--git-dir", f.remote, "ls-tree", "refs/heads/main")
            .split("\n")
            .map((line) => {
              const [metadata, path] = line.split("\t")
              return `${metadata?.split(" ")[0]} ${path}`
            })
          expect(entries).toEqual(["120000 current", "100755 run.sh"])
          expect(
            f.git("--git-dir", f.remote, "show", "refs/heads/main:current"),
          ).toBe("after.md")
          expect(
            f.git("--git-dir", f.remote, "show", "refs/heads/main:run.sh"),
          ).toBe("#!/bin/sh\necho after")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "rechecks an apparent no-op against the current default and applies the requested edit",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const { workspaceFileEdit } = await import(
          "../../openworkflow/workflows/workspace-file-edit.js"
        )
        const spec = {
          ...workspaceFileEdit.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceFileEdit.fn)
        await f.worker.stop()
        // A human changes the actual default before its webhook reaches our cached revision.
        writeFileSync(
          join(f.directory, "document-000.md"),
          "# Concurrent change\n",
        )
        f.git("add", "document-000.md")
        f.git(
          "-c",
          "user.name=Human",
          "-c",
          "user.email=human@example.test",
          "commit",
          "-m",
          "Concurrent change",
        )
        f.git("push", f.remote, "HEAD:refs/heads/main")
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_stale_noop`,
            revision: { ...f.revision, access: "write-default" },
            files: [
              {
                path: "document-000.md",
                content: "# Document 0\nCommitted body 0.\n",
              },
            ],
            deletePaths: [],
          })
          expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: true,
          })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "show",
              "refs/heads/main:document-000.md",
            ),
          ).toBe("# Document 0\nCommitted body 0.")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("2")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "can retry an identical command after native workflow admission fails",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const { default: postgres } = await import("postgres")
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { enqueueWriteJob } = await import(
          "../../openworkflow/enqueue-workspace-write-commit.js"
        )
        const ownerUrl = new URL(f.databaseUrl)
        ownerUrl.username = "ctxpipe"
        const owner = postgres(ownerUrl.toString(), { max: 1 })
        const fixtureName = `fixture_enqueue_${f.id}`
        const jobId = `wjob_${f.id}_admission`
        // This disposable database fault affects only this fixture command, never another run.
        await owner.unsafe(
          `CREATE FUNCTION public.${fixtureName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture queue admission unavailable'; END; $$`,
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await owner.unsafe(
            `CREATE TRIGGER ${fixtureName} BEFORE INSERT ON openworkflow.workflow_runs FOR EACH ROW WHEN (NEW.input->>'jobId' = '${jobId}') EXECUTE FUNCTION public.${fixtureName}()`,
          )
          const command = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            kind: "bootstrap" as const,
          }
          const errors: Error[] = []
          const rejected = await withOrgIdContext(f.org, () =>
            enqueueWriteJob(command, { error: (error) => errors.push(error) }),
          )
          expect(rejected).toEqual({ started: false })
          expect(errors).toHaveLength(1)
          expect(
            (await backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) => (run.input as { jobId?: string })?.jobId === jobId,
            ),
          ).toEqual([])
          expect(
            await withOrgIdContext(f.org, () => getWorkspaceWriteJob(jobId)),
          ).toMatchObject({ status: "failed" })
          await owner.unsafe(
            `DROP TRIGGER ${fixtureName} ON openworkflow.workflow_runs`,
          )
          const accepted = await withOrgIdContext(f.org, () =>
            enqueueWriteJob(command, {
              error: (error) => {
                throw error
              },
            }),
          )
          expect(accepted).toEqual({ started: true })
          expect(
            await withOrgIdContext(f.org, () => getWorkspaceWriteJob(jobId)),
          ).toMatchObject({ status: "queued" })
          expect(
            (await backend.listWorkflowRuns({ limit: 100 })).data.filter(
              (run) => (run.input as { jobId?: string })?.jobId === jobId,
            ),
          ).toHaveLength(1)
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await getWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 30_000 },
            )
            .toBe("completed")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..refs/heads/main`,
            ),
          ).toBe("1")
        } finally {
          await worker.stop()
          await owner.unsafe(
            `DROP TRIGGER IF EXISTS ${fixtureName} ON openworkflow.workflow_runs`,
          )
          await owner.unsafe(`DROP FUNCTION public.${fixtureName}()`)
          await owner.end()
          await backend.stop()
        }
      },
    )
  },
)
