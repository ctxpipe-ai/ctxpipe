import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"

it(
  "rebases an unpushed knowledge change onto a human update and publishes one replayable commit",
  { timeout: 60_000 },
  async () => {
    const original =
      "# Guide\n\nOwner: original\n\nOne\nTwo\nThree\nFour\nFive\n\nJob: original\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: "knowledge/guide.md", body: original },
          { path: "knowledge/obsolete.md", body: "# Obsolete\n" },
        ],
      },
      async (f) => {
        f.git("reset", "--hard", f.sha)
        writeFileSync(
          join(f.directory, "knowledge/guide.md"),
          original.replace("Owner: original", "Owner: updated by human"),
        )
        f.git("add", "knowledge/guide.md")
        f.git("commit", "-m", "Human knowledge update")
        f.git("push", f.remote, "HEAD:main")
        const humanSha = f.git("rev-parse", "HEAD")
        await withOrgIdContext(f.org, () =>
          resolveWorkspaceReadRevision({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            refresh: true,
          }),
        )
        const jobId = `wjob_${f.id}_merge`
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId,
          kind: "semantic_merge" as const,
          previousSha: f.sha,
          mergeFiles: [
            {
              path: "knowledge/guide.md",
              content: original.replace(
                "Job: original",
                "Job: imported knowledge",
              ),
            },
          ],
          mergeDeletePaths: ["knowledge/obsolete.md"],
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
            workflowName: "workspace-write-semantic-merge",
            input: {
              previousSha: f.sha,
              revision: { sha: humanSha },
              files: command.mergeFiles,
            },
          })
          const { workspaceSemanticMerge, workspaceSemanticMergeInputSchema } =
            await import(
              "../../openworkflow/workflows/workspace-semantic-merge.js"
            )
          runner.implementWorkflow(
            workspaceSemanticMerge.spec,
            workspaceSemanticMerge.fn,
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
            f.git("--git-dir", f.remote, "show", "main:knowledge/guide.md"),
          ).toBe(
            original
              .replace("Owner: original", "Owner: updated by human")
              .replace("Job: original", "Job: imported knowledge")
              .trim(),
          )
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "main",
            ),
          ).toBe("knowledge/guide.md")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${humanSha}..main`,
            ),
          ).toBe("1")
          expect(f.git("--git-dir", f.remote, "rev-parse", "main^1")).toBe(
            humanSha,
          )
          const replay = await runner.runWorkflow(
            workspaceSemanticMerge.spec,
            workspaceSemanticMergeInputSchema.parse(queued?.input),
          )
          expect(await replay.result({ timeoutMs: 15_000 })).toMatchObject({
            committed: true,
          })
          const unchanged = await runner.runWorkflow(
            workspaceSemanticMerge.spec,
            {
              ...workspaceSemanticMergeInputSchema.parse(queued?.input),
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
              `${humanSha}..main`,
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

it.each(["valid", "out-of-scope"] as const)(
  "resolves overlapping knowledge with %s model output and cleans up its provider resource",
  { timeout: 60_000 },
  async (outcome) => {
    const path = "knowledge/owners.md"
    const original = "# Owners\n\nOwners: Alice\n"
    const resolved = "# Owners\n\nOwners: Alice, Bob, Carol\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path, body: original }],
        semanticMergeResolution: {
          files: [
            {
              path: outcome === "valid" ? path : "knowledge/unrelated.md",
              content: resolved,
            },
          ],
        },
      },
      async (f) => {
        f.git("reset", "--hard", f.sha)
        writeFileSync(
          join(f.directory, path),
          original.replace("Alice", "Alice, Carol"),
        )
        f.git("add", path)
        f.git("commit", "-m", "Human adds owner")
        f.git("push", f.remote, "HEAD:main")
        await withOrgIdContext(f.org, () =>
          resolveWorkspaceReadRevision({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            refresh: true,
          }),
        )
        const { workspaceSemanticMerge } = await import(
          "../../openworkflow/workflows/workspace-semantic-merge.js"
        )
        const spec = {
          ...workspaceSemanticMerge.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceSemanticMerge.fn)
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_overlap`,
            revision: {
              ...(await f.resolveRevision()),
              access: "write-default",
            },
            previousSha: f.sha,
            files: [{ path, content: original.replace("Alice", "Alice, Bob") }],
            deletePaths: [],
          })
          if (outcome === "valid") {
            expect(await handle.result({ timeoutMs: 30_000 })).toMatchObject({
              committed: true,
            })
            expect(f.git("--git-dir", f.remote, "show", `main:${path}`)).toBe(
              resolved.trim(),
            )
            expect(f.semanticRequests).toHaveLength(1)
          } else {
            await expect(handle.result({ timeoutMs: 30_000 })).rejects.toThrow()
            expect(f.git("--git-dir", f.remote, "show", `main:${path}`)).toBe(
              original.replace("Alice", "Alice, Carol").trim(),
            )
            expect(
              f.git(
                "--git-dir",
                f.remote,
                "ls-tree",
                "-r",
                "--name-only",
                "main",
              ),
            ).toBe(path)
            expect(f.semanticRequests).toHaveLength(3)
          }
          const attempts = (
            await f.backend.listStepAttempts({
              workflowRunId: handle.workflowRun.id,
              limit: 100,
            })
          ).data
          const created = attempts.find(
            (step) => step.stepName === "create-merge-sandbox",
          )
          expect(created).toMatchObject({
            status: "completed",
            output: { provider: "unsandboxed" },
          })
          const locator = created?.output as { id: string }
          const { localProcessSandbox } = await import(
            "@tanstack/ai-sandbox-local-process"
          )
          expect(
            await localProcessSandbox().resume({ id: locator.id }),
          ).toBeNull()
          const destroyed = attempts.find(
            (step) => step.stepName === "destroy-merge-sandbox",
          )
          const pushed = attempts.find(
            (step) => step.stepName === "broker-push",
          )
          expect(destroyed?.status).toBe("completed")
          if (outcome === "valid")
            expect(destroyed?.finishedAt?.getTime()).toBeLessThanOrEqual(
              pushed?.startedAt?.getTime() ?? 0,
            )
          else expect(pushed).toBeUndefined()
          expect(JSON.stringify(attempts)).not.toContain(
            "fixture-only-github-write-token",
          )
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it.each(["paused", "running"] as const)(
  "rejects reuse of a %s command ID with a different captured payload",
  { timeout: 30_000 },
  async (status) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "read_only" },
      async (f) => {
        const jobId = `wjob_${f.id}_immutable`
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId,
          kind: "semantic_merge" as const,
          previousSha: f.sha,
          mergeFiles: [{ path: "knowledge/a.md", content: "original" }],
          mergeDeletePaths: [],
        }
        const errors: Error[] = []
        if (status === "running") {
          const { persistBoundWriteJob } = await import(
            "../../models/workspace-write-jobs.js"
          )
          await withOrgIdContext(f.org, () =>
            persistBoundWriteJob({
              id: jobId,
              kind: "semantic_merge",
              revision: { ...f.revision, access: "write-default" },
              workflowRunId: `owner_${f.id}`,
              previousSha: f.sha,
              files: command.mergeFiles,
              deletePaths: [],
            }),
          )
        } else {
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(command, { error: (error) => errors.push(error) }),
          )
        }
        const original = await withOrgIdContext(f.org, () =>
          reconcileWorkspaceWriteJob(jobId),
        )
        expect(original?.status).toBe(status)
        expect(errors).toEqual([])
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                ...command,
                mergeFiles: [{ path: "knowledge/a.md", content: "replaced" }],
              },
              { error: (error) => errors.push(error) },
            ),
          ),
        ).toEqual({ started: false })
        expect(errors).toHaveLength(1)
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          ),
        ).toEqual(original)
        errors.length = 0
        await withOrgIdContext(f.org, () =>
          enqueueWriteJob(command, { error: (error) => errors.push(error) }),
        )
        expect(errors).toEqual([])
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          ),
        ).toEqual(original)
      },
    )
  },
)

it(
  "rejects invalid semantic content before persisting a paused command",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "missing", writeStatus: "read_only" },
      async (f) => {
        const commands = [
          { previousSha: undefined },
          { previousSha: "not-an-immutable-sha" },
          { mergeFiles: [{ path: "../outside.md", content: "outside" }] },
          { mergeDeletePaths: [".git/config"] },
          {
            mergeFiles: [
              { path: "knowledge/a.md", content: "one" },
              { path: "knowledge/a.md", content: "two" },
            ],
          },
          { mergeDeletePaths: ["knowledge/a.md"] },
        ]
        for (const [index, invalid] of commands.entries()) {
          const jobId = `wjob_${f.id}_invalid_${index}`
          const errors: Error[] = []
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(
                {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  jobId,
                  kind: "semantic_merge",
                  previousSha: f.sha,
                  mergeFiles: [{ path: "knowledge/a.md", content: "captured" }],
                  mergeDeletePaths: [],
                  ...invalid,
                },
                { error: (error) => errors.push(error) },
              ),
            ),
          ).toEqual({ started: false })
          expect(errors).toHaveLength(1)
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(jobId),
            ),
          ).toBeNull()
        }
      },
    )
  },
)

it(
  "recovers the same Docker resource when sandbox creation is replayed before acknowledgement",
  { timeout: 60_000 },
  async () => {
    const { createMergeSandbox, destroyMergeSandbox } = await import(
      "./semantic-merge.js"
    )
    const { dockerSandbox } = await import("@tanstack/ai-sandbox-docker")
    const savedProvider = process.env.SANDBOX_PROVIDER
    process.env.SANDBOX_PROVIDER = "docker"
    const locators: Awaited<ReturnType<typeof createMergeSandbox>>[] = []
    try {
      const key = `native-merge-resource-${Date.now()}-${Math.random()}`
      const first = await createMergeSandbox(key)
      locators.push(first)
      const provider = dockerSandbox({ image: "node:22" })
      const original = await provider.resume({ id: first.id })
      if (!original) throw new Error("Native Docker resource was not created")
      await original.fs.write(
        "/workspace/captured.txt",
        "captured before lost acknowledgement",
      )
      const replay = await createMergeSandbox(key)
      locators.push(replay)
      expect(replay).toEqual(first)
      const resumed = await provider.resume({ id: replay.id })
      expect(await resumed?.fs.read("/workspace/captured.txt")).toBe(
        "captured before lost acknowledgement",
      )
    } finally {
      for (const locator of locators) await destroyMergeSandbox(locator)
      if (savedProvider === undefined) delete process.env.SANDBOX_PROVIDER
      else process.env.SANDBOX_PROVIDER = savedProvider
    }
  },
)
