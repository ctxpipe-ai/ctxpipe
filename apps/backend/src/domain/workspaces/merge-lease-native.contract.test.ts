import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceSemanticMerge } from "../../openworkflow/workflows/workspace-semantic-merge.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { takeWorkspaceMergeLease } from "./merge-lease.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"

// The release signal goes through the client of the production namespace,
// so the fixture worker uses that namespace.
const namespaceId = openWorkflowNamespaceId()
const mergeSpec = {
  ...workspaceSemanticMerge.spec,
  retryPolicy: { maximumAttempts: 1 },
}

async function stepNames(f: NativeHydrationFixture, workflowRunId: string) {
  const attempts = await f.backend.listStepAttempts({
    workflowRunId,
    limit: 1000,
  })
  return attempts.data.map((attempt) => ({
    name: attempt.stepName,
    status: attempt.status,
  }))
}

/** A standalone merge that adds one new file onto the fixture commit. */
function addFile(
  f: NativeHydrationFixture,
  path: string,
  revision = f.revision,
) {
  return f.runner.runWorkflow(mergeSpec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    origin: "host" as const,
    jobId: `wjob_${f.id}_${path.replace(/\W/g, "_")}`,
    revision: { ...revision, access: "write-default" as const },
    previousSha: f.sha,
    files: [{ path, content: `# ${path}\n` }],
    deletePaths: [],
  })
}

it(
  "merges concurrent changes of one Workspace one at a time, with one merge commit each and no lost race",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        namespaceId,
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
      },
      async (f) => {
        await f.publish()
        await f.worker.stop()
        f.runner.implementWorkflow(mergeSpec, workspaceSemanticMerge.fn)
        const paths = [0, 1, 2, 3].map((i) => `knowledge/change-${i}.md`)
        const worker = f.runner.newWorker({ concurrency: paths.length })
        try {
          // All merges are queued from the same old tip, as a backlog is.
          const handles = await Promise.all(paths.map((p) => addFile(f, p)))
          await worker.start()
          for (const handle of handles)
            expect(await handle.result({ timeoutMs: 90_000 })).toMatchObject({
              committed: true,
            })
          // Every change lands, each in one commit on the one before.
          const tree = f.git(
            "--git-dir",
            f.remote,
            "ls-tree",
            "-r",
            "--name-only",
            "main",
          )
          for (const path of paths) expect(tree).toContain(path)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe(String(paths.length))
          // No merge lost a push race, so none merged a second time.
          for (const handle of handles) {
            const steps = await stepNames(f, handle.workflowRun.id)
            expect(
              steps.filter((s) => s.name.startsWith("prepare-merge-commit")),
            ).toEqual([{ name: "prepare-merge-commit", status: "completed" }])
            expect(
              steps.filter(
                (s) =>
                  s.name.startsWith("discard-unpublished-candidate") ||
                  s.name.startsWith("await-quiet-default-branch"),
              ),
            ).toEqual([])
          }
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "keeps a merge waiting without a worker slot while another merge of its Workspace runs, then merges it onto the new tip",
  { timeout: 120_000 },
  async () => {
    const path = "knowledge/owners.md"
    const original = "# Owners\n\nOwners: Alice\n"
    const resolved = "# Owners\n\nOwners: Alice, Bob, Carol\n"
    await withNativeHydrationFixture(
      {
        namespaceId,
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path, body: original }],
        semanticMergeResolution: { files: [{ path, content: resolved }] },
        // The first merge asks the model, so it runs for a while.
        semanticMergeDelayMs: 8_000,
      },
      async (f) => {
        await f.publish()
        await f.worker.stop()
        f.git("reset", "--hard", f.sha)
        writeFileSync(
          join(f.directory, path),
          original.replace("Alice", "Alice, Carol"),
        )
        f.git("add", path)
        f.git("commit", "-m", "Human adds owner")
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
        const probe = { name: `merge-lease-probe-${f.id}` }
        f.runner.implementWorkflow(mergeSpec, workspaceSemanticMerge.fn)
        f.runner.implementWorkflow(probe, async () => "done")
        const worker = f.runner.newWorker({ concurrency: 2 })
        try {
          await worker.start()
          const first = await f.runner.runWorkflow(mergeSpec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            origin: "host",
            jobId: `wjob_${f.id}_conflict`,
            revision: {
              ...(await f.resolveRevision()),
              access: "write-default",
            },
            previousSha: f.sha,
            files: [{ path, content: original.replace("Alice", "Alice, Bob") }],
            deletePaths: [],
          })
          await expect
            .poll(() => stepNames(f, first.workflowRun.id), {
              timeout: 30_000,
            })
            .toContainEqual({ name: "prepare-merge-commit", status: "running" })
          // Queued on the tip before the human commit.
          const second = await addFile(f, "knowledge/second.md")
          await expect
            .poll(() => stepNames(f, second.workflowRun.id), {
              timeout: 30_000,
            })
            .toContainEqual({ name: "await-merge-lease", status: "running" })
          // The first merge holds one of the two slots. The wait holds none,
          // so other work runs.
          const other = await f.runner.runWorkflow(probe, {})
          expect(await other.result({ timeoutMs: 5_000 })).toBe("done")
          expect(
            (await stepNames(f, first.workflowRun.id)).filter((s) =>
              s.name.startsWith("broker-push"),
            ),
          ).toEqual([])
          expect(await first.result({ timeoutMs: 60_000 })).toMatchObject({
            committed: true,
          })
          // The release wakes the waiting merge, long before its timeout.
          expect(await second.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: true,
          })
          expect(f.git("--git-dir", f.remote, "show", `main:${path}`)).toBe(
            resolved.trim(),
          )
          expect(
            f.git("--git-dir", f.remote, "show", "main:knowledge/second.md"),
          ).toBe("# knowledge/second.md")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${humanSha}..main`,
            ),
          ).toBe("2")
          expect(
            (await stepNames(f, second.workflowRun.id)).filter((s) =>
              s.name.startsWith("prepare-merge-commit"),
            ),
          ).toEqual([{ name: "prepare-merge-commit", status: "completed" }])
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "takes no wait for the lease of another Workspace or of a holder that ended",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        namespaceId,
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
      },
      async (f) => {
        await f.publish()
        await f.worker.stop()
        const ended = { name: `merge-lease-ended-${f.id}` }
        f.runner.implementWorkflow(mergeSpec, workspaceSemanticMerge.fn)
        f.runner.implementWorkflow(ended, async () => "done")
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          // A merge of another Workspace that runs (it waits to start).
          const running = await f.runner.runWorkflow(
            { name: `merge-lease-other-${f.id}` },
            {},
            { availableAt: new Date(Date.now() + 60 * 60 * 1000) },
          )
          expect(
            await takeWorkspaceMergeLease({
              orgId: f.org.id,
              workspaceId: `${f.workspaceId}_other`,
              runId: running.workflowRun.id,
            }),
          ).toBe(true)
          // A merge of this Workspace that ended without its release.
          const done = await f.runner.runWorkflow(ended, {})
          await done.result({ timeoutMs: 15_000 })
          await takeWorkspaceMergeLease({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            runId: done.workflowRun.id,
          })
          const merge = await addFile(f, "knowledge/parallel.md")
          expect(await merge.result({ timeoutMs: 30_000 })).toMatchObject({
            committed: true,
          })
          const steps = await stepNames(f, merge.workflowRun.id)
          expect(steps).toContainEqual({
            name: "take-merge-lease",
            status: "completed",
          })
          expect(steps.filter((s) => s.name.startsWith("await-merge-lease")))
            .toEqual([])
          // The lease of a running merge stays with it.
          expect(
            await takeWorkspaceMergeLease({
              orgId: f.org.id,
              workspaceId: `${f.workspaceId}_other`,
              runId: merge.workflowRun.id,
            }),
          ).toBe(false)
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
