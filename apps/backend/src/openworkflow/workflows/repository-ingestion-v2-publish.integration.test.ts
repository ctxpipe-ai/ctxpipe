import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { and, eq, sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaces, workspaceWriteJobs } from "../../db/schema/workspaces.js"
import {
  contexts,
  expectOnlyContextBPublished,
  expectRefusedRunSpan,
  FLOOD_FILES,
  floodName,
  floodSha,
  folder,
  git,
  human,
  humanFormat,
  orgId,
  partialLogsOf,
  pinned,
  raceContextA,
  refsOf,
  remotes,
  resetContexts,
  runner,
  sourceFileOf,
  sourceFileText,
  startRun,
  suffix,
  unlink,
  workspaceExtractIngest,
  workspaceIds,
  wrapGit,
} from "../../test/ingestion-v2-publish.js"
import { expectSmallWriteStepOutputs } from "../../test/write-step-outputs.js"
import { openWorkflowNamespaceId } from "../namespace.js"
import { type IngestionV2Output } from "./repository-ingestion-v2.js"

// Ingestion v2 publish: the publish commit, replay, unlink, format, and race
// cases. The fixture is src/test/ingestion-v2-publish.ts.
describe("ingestion v2 publish", () => {
  beforeEach(resetContexts, 60_000)
  // No step of `workspace-write-extract-ingest` keeps Git objects (CTX-1235).
  afterEach(() => expectSmallWriteStepOutputs(orgId))

  it(
    "publishes one commit per Workspace, keeps a human commit made after the pin, and deletes the run's refs",
    { timeout: 420_000 },
    async () => {
      human.pushed = false
      const handle = await startRun("2026-10-05T00:00:00.000Z")
      const result = await handle.result({ timeoutMs: 400_000 })
      const runId = handle.workflowRun.id
      expect(result).toMatchObject({ status: "done" })
      if (!("workspaces" in result)) throw new Error("The run did not finish")
      expect(human.pushed).toBe(true)

      for (const [i, name] of contexts.entries()) {
        const bare = join(remotes, name)
        const main = git(bare, "rev-parse", "main")
        expect(result.workspaces).toContainEqual(
          expect.objectContaining({
            workspaceId: workspaceIds[i],
            published: main,
          }),
        )
        // One publish commit on the tip that the run found at publish.
        // Context B moved after the pin: the publish replays the delta on
        // the human commit.
        const parentSha = git(bare, "rev-parse", "main^")
        expect(parentSha).toBe(i === 0 ? pinned[0] : human.sha)
        expect(git(bare, "log", "-1", "--format=%B", "main")).toContain(
          `Ctxpipe-Run: ${runId}`,
        )
        const files = git(bare, "ls-tree", "-r", "--name-only", "main")
        expect(files.split("\n")).toEqual(
          expect.arrayContaining([
            "README.md",
            "knowledge/services/billing-api.md",
          ]),
        )
        // The run's refs are gone after publish.
        expect(refsOf(name, runId)).toEqual([])
      }
      // The human commit stays on context B, byte for byte.
      expect(
        git(join(remotes, contexts[1] ?? ""), "show", "main:notes/human.md"),
      ).toBe("# Notes from a person")
    },
  )

  it(
    "publishes each file of a run with more than 300 ops (CTX-1482)",
    { timeout: 420_000 },
    async () => {
      const handle = await startRun(
        "2026-10-05T00:00:00.000Z",
        floodName,
        floodSha,
      )
      const result = await handle.result({ timeoutMs: 400_000 })
      expect(result).toMatchObject({ status: "done" })
      if (!("workspaces" in result)) throw new Error("The run did not finish")
      for (const [i, name] of contexts.entries()) {
        const bare = join(remotes, name)
        // The root step's files and the repository unit.
        expect(result.workspaces).toContainEqual(
          expect.objectContaining({
            workspaceId: workspaceIds[i],
            ops: FLOOD_FILES + 1,
            rejects: 0,
            partial: 0,
            published: git(bare, "rev-parse", "main"),
          }),
        )
        const services = git(bare, "ls-tree", "-r", "--name-only", "main")
          .split("\n")
          .filter((path) => path.startsWith("knowledge/services/flood-"))
        expect(services).toHaveLength(FLOOD_FILES)
      }
    },
  )

  it(
    "makes the same commit when the publish is replayed, and stops it after a revert of the upgrade",
    { timeout: 520_000 },
    async () => {
      const first = await startRun("2026-10-05T00:00:00.000Z")
      await expect(first.result({ timeoutMs: 400_000 })).resolves.toMatchObject(
        { status: "done" },
      )
      const runId = first.workflowRun.id
      const bare = join(remotes, contexts[0] ?? "")
      const before = git(bare, "rev-parse", "main")
      const rows = await getSystemDb().execute<{ input: unknown }>(sql`
        select input from openworkflow.workflow_runs
        where namespace_id = ${openWorkflowNamespaceId()}
          and workflow_name = 'workspace-write-extract-ingest'
          and input->>'workspaceId' = ${workspaceIds[0]}
          and input->'ingest'->>'runId' = ${runId}
      `)
      expect(rows.rows).toHaveLength(1)
      // A new run of the same command: the write job holds its result.
      const replay = await runner.runWorkflow(
        workspaceExtractIngest.spec,
        rows.rows[0]?.input as never,
      )
      await expect(replay.result({ timeoutMs: 100_000 })).resolves.toEqual({
        committed: true,
        commitSha: before,
      })
      expect(git(bare, "rev-parse", "main")).toBe(before)

      // A crash before the push: the job has no result and the default
      // branch is at the pin. The command builds the same commit again.
      await withOrgDbContext(orgId, (db) =>
        db
          .delete(workspaceWriteJobs)
          .where(
            and(
              eq(workspaceWriteJobs.workspaceId, workspaceIds[0] ?? ""),
              eq(workspaceWriteJobs.kind, "extract_ingest"),
            ),
          ),
      )
      git(bare, "update-ref", "refs/heads/main", pinned[0] ?? "", before)
      const rebuilt = await runner.runWorkflow(
        workspaceExtractIngest.spec,
        rows.rows[0]?.input as never,
      )
      await expect(rebuilt.result({ timeoutMs: 100_000 })).resolves.toEqual({
        committed: true,
        commitSha: before,
      })
      expect(git(bare, "rev-parse", "main")).toBe(before)
      const jobs = await withOrgDbContext(orgId, (db) =>
        db
          .select({ id: workspaceWriteJobs.id })
          .from(workspaceWriteJobs)
          .where(
            and(
              eq(workspaceWriteJobs.workspaceId, workspaceIds[0] ?? ""),
              eq(workspaceWriteJobs.kind, "extract_ingest"),
            ),
          ),
      )
      expect(jobs).toHaveLength(1)

      // The job was queued at format 3. A revert of the upgrade pull request
      // takes the tree back to format 2: the push step reads the tree that it
      // pushes on and stops, and the default branch stays.
      await withOrgDbContext(orgId, (db) =>
        db
          .delete(workspaceWriteJobs)
          .where(
            and(
              eq(workspaceWriteJobs.workspaceId, workspaceIds[0] ?? ""),
              eq(workspaceWriteJobs.kind, "extract_ingest"),
            ),
          ),
      )
      git(bare, "update-ref", "refs/heads/main", pinned[0] ?? "", before)
      const reverted = humanFormat(contexts[0] ?? "", 2)
      const stopped = await runner.runWorkflow(
        workspaceExtractIngest.spec,
        rows.rows[0]?.input as never,
      )
      await expect(stopped.result({ timeoutMs: 100_000 })).resolves.toEqual({
        committed: false,
        reason: "publish_pipeline_stopped",
      })
      expect(git(bare, "rev-parse", "main")).toBe(reverted)
    },
  )

  it(
    "does not publish to a Workspace whose source was unlinked while the run was in flight",
    { timeout: 420_000 },
    async () => {
      unlink.armed = true
      const handle = await startRun("2026-10-14T00:00:00.000Z")
      const result = await handle.result({ timeoutMs: 400_000 })
      const runId = handle.workflowRun.id
      expect(unlink.sha).not.toBe("")
      if (!("workspaces" in result)) throw new Error("The run did not finish")
      expect(
        result.workspaces.find((w) => w.workspaceId === workspaceIds[0]),
      ).toMatchObject({ published: null })
      // Context A keeps the unlink, and the knowledge does not come back.
      const bareA = join(remotes, contexts[0] ?? "")
      expect(git(bareA, "rev-parse", "main")).toBe(unlink.sha)
      expect(git(bareA, "ls-tree", "-r", "--name-only", "main")).not.toContain(
        "knowledge/services/billing-api.md",
      )
      // Context B still links the source, so it publishes.
      expect(
        git(
          join(remotes, contexts[1] ?? ""),
          "log",
          "-1",
          "--format=%B",
          "main",
        ),
      ).toContain(`Ctxpipe-Run: ${runId}`)
    },
  )

  it(
    "publishes only to the Workspace at format 3 in a mixed run, and writes nothing to the one at format 2",
    { timeout: 420_000 },
    async () => {
      // Context B has no upgrade: its tree and its cache are at format 2.
      const bareB = join(remotes, contexts[1] ?? "")
      const below = humanFormat(contexts[1] ?? "", 2)
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: below, formatVersion: 2 })
          .where(eq(workspaces.id, workspaceIds[1] ?? "")),
      )
      const handle = await startRun("2026-10-12T00:00:00.000Z")
      const result = await handle.result({ timeoutMs: 400_000 })
      const runId = handle.workflowRun.id
      expect(result).toMatchObject({ status: "done" })
      if (!("workspaces" in result)) throw new Error("The run did not finish")
      const bareA = join(remotes, contexts[0] ?? "")
      expect(result.workspaces.map((w) => w.workspaceId)).toEqual([
        workspaceIds[0],
      ])
      expect(git(bareA, "log", "-1", "--format=%B", "main")).toContain(
        `Ctxpipe-Run: ${runId}`,
      )
      expect(git(bareB, "rev-parse", "main")).toBe(below)
      expect(refsOf(contexts[1] ?? "", runId)).toEqual([])
    },
  )

  it(
    "does not publish to a Workspace whose upgrade was reverted before hydrate cached it",
    { timeout: 420_000 },
    async () => {
      // The cache of context B still says format 3, but its pinned tree is
      // the revert of the upgrade: format 2.
      const bareB = join(remotes, contexts[1] ?? "")
      const reverted = humanFormat(contexts[1] ?? "", 2)
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredSha: reverted })
          .where(eq(workspaces.id, workspaceIds[1] ?? "")),
      )
      const handle = await startRun("2026-10-13T00:00:00.000Z")
      const result = await handle.result({ timeoutMs: 400_000 })
      const runId = handle.workflowRun.id
      if (!("workspaces" in result)) throw new Error("The run did not finish")
      expect(
        result.workspaces.find((w) => w.workspaceId === workspaceIds[1]),
      ).toMatchObject({ published: null, partial: 0 })
      expect(git(bareB, "rev-parse", "main")).toBe(reverted)
      // The run reads the pinned tree before it publishes, so no publish job
      // of context B starts.
      const publishJobs = await getSystemDb().execute(sql`
        select id from openworkflow.workflow_runs
        where namespace_id = ${openWorkflowNamespaceId()}
          and workflow_name = 'workspace-write-extract-ingest'
          and input->>'workspaceId' = ${workspaceIds[1]}
          and input->'ingest'->>'runId' = ${runId}
      `)
      expect(publishJobs.rows).toEqual([])
      expect(
        git(
          join(remotes, contexts[0] ?? ""),
          "log",
          "-1",
          "--format=%B",
          "main",
        ),
      ).toContain(`Ctxpipe-Run: ${runId}`)
    },
  )

  it(
    "marks a Workspace partial and keeps its refs when the default branch wins the push race three times",
    { timeout: 420_000 },
    async () => {
      const bare = join(remotes, contexts[0] ?? "")
      // Each tip read of context A races a person's commit.
      const flag = join(folder, "race-publish")
      writeFileSync(flag, "")
      const bin = raceContextA(flag)
      let result: IngestionV2Output
      let runId: string
      try {
        const handle = await startRun("2026-10-10T00:00:00.000Z")
        runId = handle.workflowRun.id
        result = await handle.result({ timeoutMs: 400_000 })
      } finally {
        rmSync(flag, { force: true })
        vi.stubEnv("PATH", process.env.PATH?.replace(`${bin}:`, "") ?? "")
      }
      const entry = expectOnlyContextBPublished(result, runId)
      expect(entry?.refused).toMatch(/default branch kept changing/)
      expectRefusedRunSpan(runId, ["publish_failed"])
      // The partial log names a fixed cause, not model or customer text.
      const partialLogs = partialLogsOf(runId)
      expect(partialLogs).not.toEqual([])
      expect(partialLogs.map((event) => event.reason)).toEqual(
        partialLogs.map(() => "failed"),
      )
      expect(git(bare, "log", "-1", "--format=%B", "main")).not.toContain(
        `Ctxpipe-Run: ${runId}`,
      )
      expect(refsOf(contexts[0] ?? "", runId)).not.toEqual([])
    },
  )

  it(
    "publishes when a source is added to the Workspace between the fetch and the push of the publish (CTX-1471)",
    { timeout: 420_000 },
    async () => {
      const bare = join(remotes, contexts[0] ?? "")
      // A person adds another source while the run publishes: the commit is
      // ready on a side branch, and the first push to the default branch of
      // context A moves the branch to it first.
      const work = mkdtempSync(join(folder, "source-add-"))
      git(work, "clone", "-q", bare, ".")
      const added = sourceFileOf(`acme/added-api-${suffix}`)
      mkdirSync(dirname(join(work, added)), { recursive: true })
      writeFileSync(
        join(work, added),
        sourceFileText(`acme/added-api-${suffix}`),
      )
      git(work, "add", "-A")
      git(work, "commit", "-q", "-m", "Add a source")
      git(work, "push", "-q", "origin", "HEAD:refs/heads/source-add")
      const sourceAdd = git(work, "rev-parse", "HEAD")
      const flag = join(folder, "race-source-add")
      writeFileSync(flag, "")
      const bin = wrapGit(
        "race-bin-source-add",
        [
          `if [ -f "${flag}" ]; then`,
          `case " $* " in *" push "*"context-a-${suffix}"*"refs/heads/main"*)`,
          `  rm -f "${flag}"`,
          `  "$REAL_GIT" --git-dir="${bare}" update-ref refs/heads/main ${sourceAdd} ;;`,
          "esac",
          "fi",
        ].join("\n"),
      )
      let result: IngestionV2Output
      let runId: string
      try {
        const handle = await startRun("2026-10-10T00:00:00.000Z")
        runId = handle.workflowRun.id
        result = await handle.result({ timeoutMs: 400_000 })
      } finally {
        rmSync(flag, { force: true })
        vi.stubEnv("PATH", process.env.PATH?.replace(`${bin}:`, "") ?? "")
        git(bare, "update-ref", "-d", "refs/heads/source-add")
      }
      // The push lost the race once: the publish replays the delta on the
      // new tip and pushes again.
      expect(git(bare, "rev-parse", "main^")).toBe(sourceAdd)
      expect(result).toMatchObject({ status: "done" })
      if (!("workspaces" in result)) throw new Error("The run did not finish")
      expect(result.workspaces).toContainEqual(
        expect.objectContaining({
          workspaceId: workspaceIds[0],
          published: git(bare, "rev-parse", "main"),
          partial: 0,
        }),
      )
      expect(git(bare, "log", "-1", "--format=%B", "main")).toContain(
        `Ctxpipe-Run: ${runId}`,
      )
      expect(git(bare, "ls-tree", "-r", "--name-only", "main")).toContain(added)
      expect(git(bare, "ls-tree", "-r", "--name-only", "main")).toContain(
        "knowledge/services/billing-api.md",
      )
    },
  )
})
