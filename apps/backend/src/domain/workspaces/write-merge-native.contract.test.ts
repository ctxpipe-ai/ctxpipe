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
  "resolves overlapping knowledge with %s model output",
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
          const resolveAttempts = attempts.filter(
            (step) => step.stepName === "resolve-semantic-conflicts",
          )
          const pushed = attempts.find(
            (step) => step.stepName === "broker-push",
          )
          if (outcome === "valid") {
            expect(resolveAttempts.at(-1)?.status).toBe("completed")
            expect(
              resolveAttempts.at(-1)?.finishedAt?.getTime(),
            ).toBeLessThanOrEqual(pushed?.startedAt?.getTime() ?? 0)
          } else expect(pushed).toBeUndefined()
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
        ).toMatchObject({ ...original, updatedAt: expect.any(Date) })
        errors.length = 0
        await withOrgIdContext(f.org, () =>
          enqueueWriteJob(command, { error: (error) => errors.push(error) }),
        )
        expect(errors).toEqual([])
        expect(
          await withOrgIdContext(f.org, () =>
            reconcileWorkspaceWriteJob(jobId),
          ),
        ).toMatchObject({ ...original, updatedAt: expect.any(Date) })
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

it.each([
  "credential",
  "native-push",
  "repeated-native-push",
  "continuous-native-push",
] as const)(
  "hands a raced Files write to one native semantic child and returns the published result: %s",
  { timeout: 60_000 },
  async (raceBoundary) => {
    const path = "knowledge/race.md"
    const original =
      "# Race\n\nHuman: original\n\nOne\nTwo\nThree\nFour\nFive\n\nJob: original\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path, body: original }],
      },
      async (f) => {
        const { workspaceFileEdit } = await import(
          "../../openworkflow/workflows/workspace-file-edit.js"
        )
        const { workspaceSemanticMerge } = await import(
          "../../openworkflow/workflows/workspace-semantic-merge.js"
        )
        f.runner.implementWorkflow(workspaceFileEdit.spec, workspaceFileEdit.fn)
        f.runner.implementWorkflow(
          workspaceSemanticMerge.spec,
          workspaceSemanticMerge.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        let humanSha: string | undefined
        f.onWriteCredentialRequest(async () => {
          if (humanSha) return
          f.git("reset", "--hard", f.sha)
          writeFileSync(
            join(f.directory, path),
            original.replace("Human: original", "Human: updated"),
          )
          f.git("add", path)
          f.git("commit", "-m", "Concurrent human update")
          humanSha = f.git("rev-parse", "HEAD")
          if (raceBoundary === "credential") {
            f.git("push", f.remote, "HEAD:main")
          } else {
            // Materialize the human commit without advancing main. Git's native
            // update hook advances it only after the broker's final tip check.
            const humanTips = [humanSha]
            const additionalHumans =
              raceBoundary === "continuous-native-push"
                ? 3
                : raceBoundary === "repeated-native-push"
                  ? 1
                  : 0
            for (let index = 0; index < additionalHumans; index++) {
              const path = `knowledge/human-${index}.md`
              writeFileSync(join(f.directory, path), "# Another human update\n")
              f.git("add", path)
              f.git("commit", "-m", "Another concurrent human update")
              humanSha = f.git("rev-parse", "HEAD")
              humanTips.push(humanSha)
            }
            f.git(
              "--git-dir",
              f.remote,
              "fetch",
              f.directory,
              `${humanSha}:refs/heads/fixture-human`,
            )
            const cases = humanTips
              .map(
                (sha, index) =>
                  `${index ? humanTips[index - 1] : f.sha}) git update-ref "$1" ${sha} "$2" ;;`,
              )
              .join("\n")
            writeFileSync(
              join(f.remote, "hooks/update"),
              `#!/bin/sh\nset -e\ncase "$2" in\n${cases}\n*) rm -- "$0" ;;\nesac\n`,
              { mode: 0o755 },
            )
          }
        })
        const command = {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_race`,
          revision: { ...f.revision, access: "write-default" as const },
          files: [
            {
              path,
              content: original.replace("Job: original", "Job: imported"),
            },
          ],
          deletePaths: [],
        }
        try {
          await worker.start()
          const handle = await f.runner.runWorkflow(
            workspaceFileEdit.spec,
            command,
          )
          if (raceBoundary === "continuous-native-push") {
            await expect(handle.result({ timeoutMs: 30_000 })).rejects.toThrow(
              "Default branch kept changing during semantic merge",
            )
            expect(
              (
                await f.backend.getWorkflowRun({
                  workflowRunId: handle.workflowRun.id,
                })
              )?.status,
            ).toBe("failed")
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              humanSha,
            )
            expect(f.git("--git-dir", f.remote, "show", `main:${path}`)).toBe(
              original.replace("Human: original", "Human: updated").trim(),
            )
            expect(
              await withOrgIdContext(f.org, () =>
                reconcileWorkspaceWriteJob(command.jobId),
              ),
            ).toMatchObject({ commitSha: null })
            return
          }
          const result = await handle.result({ timeoutMs: 30_000 })
          expect(result).toMatchObject({ committed: true })
          expect(f.git("--git-dir", f.remote, "show", `main:${path}`)).toBe(
            original
              .replace("Human: original", "Human: updated")
              .replace("Job: original", "Job: imported")
              .trim(),
          )
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${humanSha}..main`,
            ),
          ).toBe("1")
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(command.jobId),
            ),
          ).toMatchObject({
            status: "completed",
            commitSha: f.git("--git-dir", f.remote, "rev-parse", "main"),
          })
          const runs = (await f.backend.listWorkflowRuns({ limit: 100 })).data
          expect(
            await withOrgIdContext(f.org, () =>
              reconcileWorkspaceWriteJob(`${command.jobId}:semantic`),
            ),
          ).toBeNull()
          expect(
            runs.filter(
              (run) => run.workflowName === "workspace-write-semantic-merge",
            ),
          ).toHaveLength(1)
          const replay = await f.runner.runWorkflow(
            workspaceFileEdit.spec,
            command,
          )
          expect(await replay.result({ timeoutMs: 10_000 })).toEqual(result)
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it.each([
  { currentDeletes: false, keepFile: false, committed: true },
  { currentDeletes: true, keepFile: true, committed: true },
  { currentDeletes: false, keepFile: true, committed: false },
  { currentDeletes: true, keepFile: false, committed: false },
])(
  "resolves a modify/delete conflict: %j",
  { timeout: 40_000 },
  async (choice) => {
    const path = "knowledge/conflict.md"
    const modified = "# Updated knowledge\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path, body: "# Original knowledge\n" },
          { path: "knowledge/keep.md", body: "# Keep\n" },
        ],
        semanticMergeResolution: {
          files: [{ path, content: choice.keepFile ? modified : null }],
        },
      },
      async (f) => {
        f.git("reset", "--hard", f.sha)
        if (choice.currentDeletes) f.git("rm", path)
        else {
          writeFileSync(join(f.directory, path), modified)
          f.git("add", path)
        }
        f.git("commit", "-m", "Human conflict side")
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
        const { workspaceSemanticMerge } = await import(
          "../../openworkflow/workflows/workspace-semantic-merge.js"
        )
        f.runner.implementWorkflow(
          workspaceSemanticMerge.spec,
          workspaceSemanticMerge.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const command = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_modify_delete`,
            revision: {
              ...(await f.resolveRevision()),
              access: "write-default" as const,
            },
            previousSha: f.sha,
            files: choice.currentDeletes ? [{ path, content: modified }] : [],
            deletePaths: choice.currentDeletes ? [] : [path],
          }
          const handle = await f.runner.runWorkflow(
            workspaceSemanticMerge.spec,
            command,
          )
          const result = await handle.result({ timeoutMs: 15_000 })
          expect(result).toMatchObject(
            choice.committed
              ? { committed: true }
              : { committed: false, reason: "no_changes" },
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
          ).toBe(
            choice.keepFile
              ? "knowledge/conflict.md\nknowledge/keep.md"
              : "knowledge/keep.md",
          )
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${humanSha}..main`,
            ),
          ).toBe(choice.committed ? "1" : "0")
          const replay = await f.runner.runWorkflow(
            workspaceSemanticMerge.spec,
            command,
          )
          expect(await replay.result({ timeoutMs: 5_000 })).toEqual(result)
          const { BackendPostgres } = await import("openworkflow/postgres")
          const backend = await BackendPostgres.connect(f.databaseUrl, {
            runMigrations: false,
          })
          try {
            const hydrates = (
              await backend.listWorkflowRuns({ limit: 100 })
            ).data.filter(
              (run) =>
                run.workflowName === "workspace-hydrate" &&
                (run.input as { workspaceId?: string })?.workspaceId ===
                  f.workspaceId,
            )
            expect(hydrates).toHaveLength(1)
            expect(hydrates[0]?.input).toMatchObject({
              revision: {
                sha: f.git("--git-dir", f.remote, "rev-parse", "main"),
              },
            })
          } finally {
            await backend.stop()
          }
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
