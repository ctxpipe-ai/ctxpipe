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
