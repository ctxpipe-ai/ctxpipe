import { createHash } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getOrgDb } from "../../db/client.js"
import { workspaceWriteJobs } from "../../db/schema/workspaces.js"
import {
  getWriteJobRefState,
  persistBoundWriteJob,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import { orgSql } from "../../models/workspace-sql.js"
import {
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import { workspaceFileEdit } from "../../openworkflow/workflows/workspace-file-edit.js"
import { defineKnowledgeRewriteWorkflow } from "../../openworkflow/workflows/workspace-knowledge-rewrite.js"
import { workspaceSemanticMerge } from "../../openworkflow/workflows/workspace-semantic-merge.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"
import {
  attemptWorkspaceCommit,
  cleanUpWorkspaceWriteRefs,
  writeJobRef,
} from "./write-broker.js"
import {
  acquireWorkspaceWriteRevision,
  prepareSemanticMergeCommit,
  prepareWorkspaceWriteCommit,
} from "./write-command.js"

// OpenWorkflow keeps each step output in Postgres and reads all of them
// again on each claim of a run. A step output with Git objects put the
// Workspace through Postgres for each write (CTX-955, CTX-1232). A write step
// now pushes its commit to a job ref and returns only the commit identity
// (CTX-1235). The step that makes the content of a write also commits it, so
// no step output holds a file either (CTX-1239). `withNativeHydrationFixture`
// checks that each completed write step output of a test is at most 4 KiB.

/** About 256 KiB of text that Git cannot compress much. */
const largeBody = Array.from({ length: 4096 }, (_, index) =>
  createHash("sha256").update(String(index)).digest("hex"),
).join("\n")

const NOTES = "knowledge/notes.md"
const original = "# Owners\n\nOwners: Alice\n"

const fixture = (
  answer: { files: Array<{ path: string; content: string | null }> } = {
    files: [],
  },
): Parameters<typeof withNativeHydrationFixture>[0] => ({
  github: true,
  githubWriteView: "writable",
  writeStatus: "writable",
  files: [
    { path: "large.md", body: largeBody },
    { path: NOTES, body: original },
  ],
  semanticMergeResolution: answer,
})

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

async function stepOutputs(f: Fixture, workflowRunId: string) {
  const attempts = await f.backend.listStepAttempts({
    workflowRunId,
    limit: 1000,
  })
  return new Map(
    attempts.data
      .filter((attempt) => attempt.status === "completed")
      .map((attempt) => [attempt.stepName, attempt.output]),
  )
}

function writeRefs(f: Fixture): string[] {
  return f
    .git(
      "--git-dir",
      f.remote,
      "for-each-ref",
      "--format=%(refname)",
      "refs/ctxpipe/write/",
    )
    .split("\n")
    .filter(Boolean)
}

/** A person changes the owners line on the default branch: a conflict for a write from `f.sha`. */
async function humanEditsOwners(f: Fixture) {
  f.git("reset", "--hard", f.sha)
  writeFileSync(join(f.directory, NOTES), original.replace("Alice", "Carol"))
  f.git("add", NOTES)
  f.git("commit", "-m", "Human changes the owners")
  f.git("push", f.remote, "HEAD:main")
  const resolved = await withOrgIdContext(f.org, () =>
    resolveWorkspaceReadRevision({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      env: parseEnv(process.env),
      refresh: true,
    }),
  )
  if (!resolved) throw new Error("The fixture revision did not resolve")
  return { ...resolved.revision, access: "write-default" as const }
}

/** A semantic merge job of `f`, bound as the workflow binds it, and its acquired tip. */
async function mergeJob(f: Fixture, jobId: string) {
  const revision = await humanEditsOwners(f)
  const input = {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    jobId,
    origin: "host" as const,
    revision,
    previousSha: f.sha,
    files: [{ path: NOTES, content: original.replace("Alice", "Bob") }],
    deletePaths: [],
  }
  const env = parseEnv(process.env)
  return withOrgIdContext(f.org, async () => {
    await persistBoundWriteJob({
      id: jobId,
      kind: "semantic_merge",
      revision,
      workflowRunId: `run_${jobId}`,
      previousSha: input.previousSha,
      files: input.files,
      deletePaths: input.deletePaths,
    })
    const acquired = await acquireWorkspaceWriteRevision(
      input,
      revision,
      env,
      input.previousSha,
    )
    if (!acquired) throw new Error("The fixture Workspace is not writable")
    const prepare = () =>
      prepareSemanticMergeCommit(
        input,
        revision,
        acquired.pack,
        "2026-11-09T00:00:00Z",
        env,
      )
    return { input, revision, env, prepare }
  })
}

it(
  "keeps each step output of a file edit small, lands the write, and deletes its job ref",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(fixture(), async (f) => {
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
          jobId: `wjob_${f.id}_edit`,
          revision: { ...f.revision, access: "write-default" },
          files: [{ path: NOTES, content: `# Owners\n\n${largeBody}\n` }],
          deletePaths: [],
        })
        const result = await handle.result({ timeoutMs: 60_000 })
        expect(result).toMatchObject({ committed: true })
        expect(f.git("--git-dir", f.remote, "show", `main:${NOTES}`)).toBe(
          `# Owners\n\n${largeBody}`,
        )
        const outputs = await stepOutputs(f, handle.workflowRun.id)
        const prepared = outputs.get("prepare-commit") as Record<
          string,
          unknown
        >
        expect(Object.keys(prepared).sort()).toEqual(["base", "sha", "tree"])
        expect(prepared).toMatchObject({
          sha: result.committed ? result.commitSha : "",
          base: f.sha,
        })
        for (const retired of [
          "acquire-revision",
          "transform-file-edit",
          "commit-subject",
          "stage",
          "commit",
        ])
          expect(outputs.has(retired)).toBe(false)
        // The `complete` step deleted the job ref.
        expect(writeRefs(f)).toEqual([])
      } finally {
        await worker.stop()
      }
    })
  },
)

it(
  "keeps each step output of a knowledge rewrite small and lands the write",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(fixture(), async (f) => {
      // The import-key cleanup and the ownership migration share this
      // workflow; this one rewrites the owners line.
      const rewrite = defineKnowledgeRewriteWorkflow({
        name: "workspace-write-import-key-cleanup",
        kind: "import_key_cleanup",
        transform: (files) =>
          files.flatMap((file) =>
            file.path === NOTES
              ? [{ ...file, content: `${file.content}\n${largeBody}\n` }]
              : [],
          ),
      })
      const spec = { ...rewrite.spec, retryPolicy: { maximumAttempts: 1 } }
      f.runner.implementWorkflow(spec, rewrite.fn)
      await f.worker.stop()
      const worker = f.runner.newWorker({ concurrency: 1 })
      await worker.start()
      try {
        const handle = await f.runner.runWorkflow(spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          jobId: `wjob_${f.id}_rewrite`,
          revision: { ...f.revision, access: "write-default" },
        })
        expect(await handle.result({ timeoutMs: 60_000 })).toMatchObject({
          committed: true,
        })
        expect(f.git("--git-dir", f.remote, "show", `main:${NOTES}`)).toBe(
          `${original}\n${largeBody}`,
        )
        const outputs = await stepOutputs(f, handle.workflowRun.id)
        expect(outputs.get("prepare-commit")).toMatchObject({ base: f.sha })
        for (const retired of [
          "transform-import-key-cleanup",
          "commit-subject",
        ])
          expect(outputs.has(retired)).toBe(false)
        expect(writeRefs(f)).toEqual([])
      } finally {
        await worker.stop()
      }
    })
  },
)

it(
  "lands a semantic merge with a conflict and keeps its step outputs small",
  { timeout: 90_000 },
  async () => {
    const resolved = "# Owners\n\nOwners: Bob, Carol\n"
    await withNativeHydrationFixture(
      fixture({ files: [{ path: NOTES, content: resolved }] }),
      async (f) => {
        const revision = await humanEditsOwners(f)
        const spec = {
          ...workspaceSemanticMerge.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceSemanticMerge.fn)
        await f.worker.stop()
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId: `wjob_${f.id}_merge`,
            origin: "host",
            revision,
            previousSha: f.sha,
            files: [{ path: NOTES, content: original.replace("Alice", "Bob") }],
            deletePaths: [],
          })
          expect(await handle.result({ timeoutMs: 60_000 })).toMatchObject({
            committed: true,
          })
          expect(f.git("--git-dir", f.remote, "show", `main:${NOTES}`)).toBe(
            resolved.trim(),
          )
          expect(f.git("--git-dir", f.remote, "show", "main:large.md")).toBe(
            largeBody,
          )
          expect(f.semanticRequests).toHaveLength(1)
          const outputs = await stepOutputs(f, handle.workflowRun.id)
          expect(outputs.get("prepare-merge-commit")).toMatchObject({
            base: revision.sha,
          })
          for (const retired of [
            "transform-semantic-merge",
            "resolve-semantic-conflicts",
            "commit-subject",
            "stage",
            "commit",
          ])
            expect(outputs.has(retired)).toBe(false)
          expect(writeRefs(f)).toEqual([])
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "returns the pushed commit on a replay of a prepare step, also when its transform answers differently",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(fixture(), async (f) => {
      const jobId = `wjob_${f.id}_transform_replay`
      const revision = { ...f.revision, access: "write-default" as const }
      const input = {
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        jobId,
        revision,
      }
      const env = parseEnv(process.env)
      await withOrgIdContext(f.org, async () => {
        await persistBoundWriteJob({
          id: jobId,
          kind: "import_key_cleanup",
          revision,
          workflowRunId: `run_${jobId}`,
        })
        const acquired = await acquireWorkspaceWriteRevision(
          input,
          revision,
          env,
        )
        if (!acquired) throw new Error("The fixture Workspace is not writable")
        // A transform can ask a model, so a replay can get another answer.
        let owner = "Bob"
        let transforms = 0
        const prepare = () =>
          prepareWorkspaceWriteCommit(
            input,
            revision,
            acquired.pack,
            {
              change: async () => {
                transforms++
                return {
                  files: [
                    { path: NOTES, content: `# Owners\n\nOwners: ${owner}\n` },
                  ],
                  deletePaths: [],
                }
              },
              subject: { trigger: "import_key_cleanup" },
              createdAt: "2026-11-09T00:00:00Z",
            },
            env,
          )
        const first = await prepare()
        if (!first || first === "paused") throw new Error("No commit")
        expect(writeRefs(f)).toEqual([writeJobRef(jobId, first.sha)])
        expect((await getWriteJobRefState(jobId))?.commitSha).toBe(first.sha)
        // The step crashed after its push and its record, before OpenWorkflow
        // stored its output. The replay runs the same step again.
        owner = "Erin"
        expect(await prepare()).toEqual(first)
        expect(transforms).toBe(1)
        expect(writeRefs(f)).toEqual([writeJobRef(jobId, first.sha)])
        expect(
          f.git("--git-dir", f.remote, "show", `${first.sha}:${NOTES}`),
        ).toBe("# Owners\n\nOwners: Bob")
      })
    })
  },
)

it(
  "returns the pushed merge commit on a replay, also when the model answers differently",
  { timeout: 90_000 },
  async () => {
    const answer = {
      files: [{ path: NOTES, content: "# Owners\n\nOwners: Bob, Carol\n" }],
    }
    await withNativeHydrationFixture(fixture(answer), async (f) => {
      const { prepare } = await mergeJob(f, `wjob_${f.id}_replay`)
      const first = await withOrgIdContext(f.org, prepare)
      if (!first || first === "paused") throw new Error("No merge commit")
      expect(writeRefs(f)).toEqual([
        writeJobRef(`wjob_${f.id}_replay`, first.sha),
      ])
      expect(f.semanticRequests).toHaveLength(1)
      // The step crashed after its push and its record, before OpenWorkflow
      // stored its output. The replay asks for the same step again, and the
      // model would now answer differently.
      answer.files = [{ path: NOTES, content: "# Owners\n\nOwners: Erin\n" }]
      expect(await withOrgIdContext(f.org, prepare)).toEqual(first)
      expect(f.semanticRequests).toHaveLength(1)
      expect(writeRefs(f)).toHaveLength(1)
      expect(
        f.git("--git-dir", f.remote, "show", `${first.sha}:${NOTES}`),
      ).toBe("# Owners\n\nOwners: Bob, Carol")
    })
  },
)

it(
  "makes a new merge commit on a replay when the job ref push failed after the record",
  { timeout: 90_000 },
  async () => {
    const answer = {
      files: [{ path: NOTES, content: "# Owners\n\nOwners: Bob, Carol\n" }],
    }
    await withNativeHydrationFixture(fixture(answer), async (f) => {
      const jobId = `wjob_${f.id}_refused`
      const { prepare } = await mergeJob(f, jobId)
      // The Git host refuses the job ref: the step recorded its commit, and
      // no push sent it.
      const hook = join(f.remote, "hooks/update")
      writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      await expect(withOrgIdContext(f.org, prepare)).rejects.toThrow()
      const recorded = (
        await withOrgIdContext(f.org, () => getWriteJobRefState(jobId))
      )?.commitSha
      expect(recorded).toMatch(/^[0-9a-f]{40}$/)
      expect(writeRefs(f)).toEqual([])
      rmSync(hook)
      answer.files = [{ path: NOTES, content: "# Owners\n\nOwners: Erin\n" }]
      const replayed = await withOrgIdContext(f.org, prepare)
      if (!replayed || replayed === "paused") throw new Error("No commit")
      expect(replayed.sha).not.toBe(recorded)
      expect(writeRefs(f)).toEqual([writeJobRef(jobId, replayed.sha)])
      expect(
        (await withOrgIdContext(f.org, () => getWriteJobRefState(jobId)))
          ?.commitSha,
      ).toBe(replayed.sha)
      expect(f.semanticRequests).toHaveLength(2)
    })
  },
)

it(
  "finishes with the commit that a run pushed to the default branch before its steps got new names",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      fixture({
        files: [{ path: NOTES, content: "# Owners\n\nOwners: Erin\n" }],
      }),
      async (f) => {
        const jobId = `wjob_${f.id}_deployed`
        const { input, revision, env, prepare } = await mergeJob(f, jobId)
        // The old `commit` step recorded this merge commit, and the old
        // `broker-push` step pushed it. Its stored outputs have the old step
        // names, so no new step reads them.
        writeFileSync(
          join(f.directory, NOTES),
          "# Owners\n\nOwners: Bob, Carol\n",
        )
        f.git("commit", "-am", "Merge from before the deploy")
        const pushed = f.git("rev-parse", "HEAD")
        f.git("push", f.remote, "HEAD:main")
        await withOrgIdContext(f.org, () =>
          persistWriteJobPreparedCommit(jobId, pushed),
        )
        const replayed = await withOrgIdContext(f.org, prepare)
        expect(replayed).toEqual({
          sha: pushed,
          tree: f.git("rev-parse", "HEAD^{tree}"),
          base: revision.sha,
        })
        expect(f.semanticRequests).toHaveLength(0)
        if (!replayed || replayed === "paused") throw new Error("No commit")
        // The stored `broker-push` output says that the push happened; a new
        // push attempt finds the commit on the default branch too.
        expect(
          await withOrgIdContext(f.org, () =>
            attemptWorkspaceCommit(input, revision, replayed, env),
          ),
        ).toEqual({ pushed: true })
      },
    )
  },
)

it(
  "replaces a merge commit that a run recorded before its steps got new names and never pushed",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(
      fixture({
        files: [{ path: NOTES, content: "# Owners\n\nOwners: Erin\n" }],
      }),
      async (f) => {
        const jobId = `wjob_${f.id}_unpushed`
        const { prepare } = await mergeJob(f, jobId)
        // The old `commit` step recorded a commit that only its pack held.
        writeFileSync(join(f.directory, NOTES), "# Owners\n\nOwners: Bob\n")
        f.git("commit", "-am", "Merge that no push sent")
        const lost = f.git("rev-parse", "HEAD")
        await withOrgIdContext(f.org, () =>
          persistWriteJobPreparedCommit(jobId, lost),
        )
        const replayed = await withOrgIdContext(f.org, prepare)
        if (!replayed || replayed === "paused") throw new Error("No commit")
        expect(replayed.sha).not.toBe(lost)
        expect(f.semanticRequests).toHaveLength(1)
        expect(
          (await withOrgIdContext(f.org, () => getWriteJobRefState(jobId)))
            ?.commitSha,
        ).toBe(replayed.sha)
        expect(
          f.git("--git-dir", f.remote, "show", `${replayed.sha}:${NOTES}`),
        ).toBe("# Owners\n\nOwners: Erin")
      },
    )
  },
)

it(
  "lands a semantic handoff that a parent recorded with its files before the deploy",
  { timeout: 90_000 },
  async () => {
    const resolved = "# Owners\n\nOwners: Bob, Carol\n"
    await withNativeHydrationFixture(
      fixture({ files: [{ path: NOTES, content: resolved }] }),
      async (f) => {
        const jobId = `wjob_${f.id}_legacy_handoff`
        const ownerRunId = `run_${jobId}`
        const files = [{ path: NOTES, content: original.replace("Alice", "Bob") }]
        // The candidate of the parent: before CTX-1239 it went to no job ref.
        f.git("reset", "--hard", f.sha)
        writeFileSync(join(f.directory, NOTES), files[0]?.content ?? "")
        f.git("commit", "-am", "Candidate from before the deploy")
        const candidateSha = f.git("rev-parse", "HEAD")
        const revision = await humanEditsOwners(f)
        await withOrgIdContext(f.org, () =>
          persistBoundWriteJob({
            id: jobId,
            kind: "ui_file_edit",
            revision: { ...f.revision, access: "write-default" },
            workflowRunId: ownerRunId,
            files,
            deletePaths: [],
          }),
        )
        // The old `capture-semantic-handoff` step stored the files.
        await withOrgIdContext(f.org, () =>
          orgSql(() =>
            getOrgDb()
              .update(workspaceWriteJobs)
              .set({
                commitSha: candidateSha,
                payload: sql`jsonb_set(${workspaceWriteJobs.payload}, '{semanticHandoff}', ${JSON.stringify(
                  { ownerRunId, candidateSha, revision, files, deletePaths: [] },
                )}::jsonb)`,
              })
              .where(eq(workspaceWriteJobs.id, jobId)),
          ),
        )
        const spec = {
          ...workspaceSemanticMerge.spec,
          retryPolicy: { maximumAttempts: 1 },
        }
        f.runner.implementWorkflow(spec, workspaceSemanticMerge.fn)
        await f.worker.stop()
        const worker = f.runner.newWorker({ concurrency: 1 })
        await worker.start()
        try {
          // The child input that the old parent queued.
          const handle = await f.runner.runWorkflow(spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            origin: "host",
            revision,
            previousSha: f.sha,
            files,
            deletePaths: [],
            handoff: { ownerRunId, candidateSha },
          })
          expect(await handle.result({ timeoutMs: 60_000 })).toMatchObject({
            committed: true,
          })
          expect(f.git("--git-dir", f.remote, "show", `main:${NOTES}`)).toBe(
            resolved.trim(),
          )
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "the tip check deletes the job refs of completed and failed jobs, and keeps the refs of an active or unknown job",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(fixture(), async (f) => {
      const env = parseEnv(process.env)
      const revision = { ...f.revision, access: "write-default" as const }
      const refFor = (jobId: string) => {
        f.git("reset", "--hard", f.sha)
        writeFileSync(join(f.directory, NOTES), `# ${jobId}\n`)
        f.git("add", NOTES)
        f.git("commit", "-m", jobId)
        const sha = f.git("rev-parse", "HEAD")
        const ref = writeJobRef(jobId, sha)
        f.git("push", f.remote, `${sha}:${ref}`)
        return ref
      }
      const active = `wjob_${f.id}_active`
      const completed = `wjob_${f.id}_completed`
      const failed = `wjob_${f.id}_failed`
      await withOrgIdContext(f.org, async () => {
        for (const id of [active, completed, failed])
          await persistBoundWriteJob({
            id,
            kind: "ui_file_edit",
            revision,
            workflowRunId: `run_${id}`,
            files: [],
            deletePaths: [],
          })
        await persistWriteJobCommitSha(completed, null)
        await persistWriteJobStatus(failed, "failed")
      })
      const kept = [refFor(active), refFor(`wjob_${f.id}_unknown`)]
      const finished = [refFor(completed), refFor(failed)]
      const deleted = await withOrgIdContext(f.org, () =>
        cleanUpWorkspaceWriteRefs(
          { orgId: f.org.id, workspaceId: f.workspaceId },
          env,
        ),
      )
      expect(deleted.sort()).toEqual(finished.sort())
      expect(writeRefs(f).sort()).toEqual(kept.sort())
    })
  },
)

it("refuses a job ref name that is not a plain job id and a full SHA", () => {
  expect(() => writeJobRef("wjob_1/../main", "a".repeat(40))).toThrow()
  expect(() => writeJobRef("wjob_1", "HEAD")).toThrow()
  expect(writeJobRef("wjob_1", "a".repeat(40))).toBe(
    `refs/ctxpipe/write/wjob_1/${"a".repeat(40)}`,
  )
})
