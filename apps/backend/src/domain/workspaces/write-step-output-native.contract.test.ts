import { createHash } from "node:crypto"
import { renameSync } from "node:fs"

import { sql } from "drizzle-orm"
import { expect, it } from "vitest"

import { getSystemDb } from "../../db/client.js"
import { workspaceFileEdit } from "../../openworkflow/workflows/workspace-file-edit.js"
import { workspaceSemanticMerge } from "../../openworkflow/workflows/workspace-semantic-merge.js"
import { readGitPackFromRemote } from "../../services/git/pack.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceRootPath } from "./root-path.js"

// OpenWorkflow reads each step output of a run again from Postgres on each
// claim. A Git pack in a step output put the whole Workspace through Postgres
// for each write (CTX-955).

/** About 256 KiB of text that Git cannot compress much. */
const largeBody = Array.from({ length: 4096 }, (_, index) =>
  createHash("sha256").update(String(index)).digest("hex"),
).join("\n")

const fixture: Parameters<typeof withNativeHydrationFixture>[0] = {
  github: true,
  githubWriteView: "writable",
  writeStatus: "writable",
  files: [
    { path: "large.md", body: largeBody },
    { path: "notes.md", body: "# Notes\nBefore.\n" },
  ],
}

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

async function startFileEdit(f: Fixture, jobId: string) {
  const spec = {
    ...workspaceFileEdit.spec,
    retryPolicy: { maximumAttempts: 1 },
  }
  f.runner.implementWorkflow(spec, workspaceFileEdit.fn)
  await f.worker.stop()
  const worker = f.runner.newWorker({ concurrency: 1 })
  await worker.start()
  const handle = await f.runner.runWorkflow(spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    jobId,
    revision: { ...f.revision, access: "write-default" },
    files: [{ path: "notes.md", content: "# Notes\nAfter.\n" }],
    deletePaths: [],
  })
  return { worker, handle }
}

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

it(
  "keeps each step output of a write small and lands the write",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(fixture, async (f) => {
      const { worker, handle } = await startFileEdit(f, `wjob_${f.id}_small`)
      try {
        expect(await handle.result({ timeoutMs: 60_000 })).toMatchObject({
          committed: true,
        })
        expect(
          f.git("--git-dir", f.remote, "show", "refs/heads/main:notes.md"),
        ).toBe("# Notes\nAfter.")
        const outputs = await stepOutputs(f, handle.workflowRun.id)
        for (const name of ["acquire-revision", "stage", "commit"]) {
          expect(outputs.has(name)).toBe(true)
          expect(JSON.stringify(outputs.get(name)).length, name).toBeLessThan(
            4096,
          )
        }
      } finally {
        await worker.stop()
      }
    })
  },
)

it(
  "finishes a run whose stored acquire-revision output still holds the whole pack",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(fixture, async (f) => {
      // The pack in the shape that a run started before CTX-955 stored.
      const pack = await readGitPackFromRemote({
        url: f.revision.remote.url,
        sha: f.revision.sha,
        root: workspaceRootPath(f.revision),
      })
      expect(pack.base).toBeUndefined()
      expect(pack.objects.length).toBeGreaterThan(64 * 1024)
      // With no remote, the step after acquire-revision fails and the run
      // starts again from its stored step outputs.
      const away = `${f.remote}.away`
      renameSync(f.remote, away)
      let restored = false
      const restore = () => {
        if (restored) return
        restored = true
        renameSync(away, f.remote)
      }
      const { worker, handle } = await startFileEdit(f, `wjob_${f.id}_old`)
      try {
        for (;;) {
          const attempts = await f.backend.listStepAttempts({
            workflowRunId: handle.workflowRun.id,
            limit: 1000,
          })
          if (
            attempts.data.some(
              (attempt) =>
                attempt.stepName === "transform-file-edit" &&
                attempt.status === "failed",
            )
          )
            break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const acquired = (await stepOutputs(f, handle.workflowRun.id)).get(
          "acquire-revision",
        ) as { displayName: string }
        await getSystemDb().execute(sql`
          update openworkflow.step_attempts
          set output = ${JSON.stringify({ pack, displayName: acquired.displayName })}::jsonb
          where workflow_run_id = ${handle.workflowRun.id}
            and step_name = 'acquire-revision'
            and status = 'completed'
        `)
        restore()
        expect(await handle.result({ timeoutMs: 90_000 })).toMatchObject({
          committed: true,
        })
        expect(
          f.git("--git-dir", f.remote, "show", "refs/heads/main:notes.md"),
        ).toBe("# Notes\nAfter.")
        // The run used the stored pack: its staged pack has no base.
        const staged = (await stepOutputs(f, handle.workflowRun.id)).get(
          "stage",
        ) as { pack: { base?: unknown } }
        expect(staged.pack.base).toBeUndefined()
      } finally {
        restore()
        await worker.stop()
      }
    })
  },
)

it(
  "keeps the merge candidate and the staged tree of a semantic merge small",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture(fixture, async (f) => {
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
          revision: { ...f.revision, access: "write-default" },
          previousSha: f.revision.sha,
          files: [{ path: "notes.md", content: "# Notes\nMerged.\n" }],
          deletePaths: [],
        })
        expect(await handle.result({ timeoutMs: 60_000 })).toMatchObject({
          committed: true,
        })
        expect(
          f.git("--git-dir", f.remote, "show", "refs/heads/main:large.md"),
        ).toBe(largeBody)
        const outputs = await stepOutputs(f, handle.workflowRun.id)
        for (const name of ["transform-semantic-merge", "stage"]) {
          expect(outputs.has(name)).toBe(true)
          expect(JSON.stringify(outputs.get(name)).length, name).toBeLessThan(
            4096,
          )
        }
      } finally {
        await worker.stop()
      }
    })
  },
)
