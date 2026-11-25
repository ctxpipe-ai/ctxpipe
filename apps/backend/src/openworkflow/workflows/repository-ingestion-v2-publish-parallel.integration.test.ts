import { join } from "node:path"

import { sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getSystemDb } from "../../db/client.js"
import {
  contexts,
  git,
  orgId,
  parallelNames,
  parallelShas,
  pinned,
  remotes,
  resetContexts,
  startRun,
  workspaceIds,
} from "../../test/ingestion-v2-publish.js"
import { expectSmallWriteStepOutputs } from "../../test/write-step-outputs.js"
import { openWorkflowNamespaceId } from "../namespace.js"

// Ingestion v2 publish: the runs of the source repositories of one
// re-ingestion publish to one Workspace at the same time (CTX-1621). The
// fixture is src/test/ingestion-v2-publish.ts.
describe("ingestion v2 publish", () => {
  beforeEach(resetContexts, 60_000)
  // No step of `workspace-write-extract-ingest` keeps Git objects (CTX-1235).
  afterEach(() => expectSmallWriteStepOutputs(orgId))

  it(
    "lands each publish of runs that pinned the same Workspace revision and publish at the same time",
    { timeout: 600_000 },
    async () => {
      const workspaceId = workspaceIds[0] ?? ""
      const handles = await Promise.all(
        parallelNames.map((name, i) =>
          startRun("2026-10-20T00:00:00.000Z", name, parallelShas[i], [
            workspaceId,
          ]),
        ),
      )
      const results = await Promise.all(
        handles.map((handle) => handle.result({ timeoutMs: 580_000 })),
      )
      for (const result of results)
        expect(result).toMatchObject({
          status: "done",
          workspaces: [
            {
              workspaceId,
              partial: 0,
              published: expect.stringMatching(/^[0-9a-f]{40}$/),
            },
          ],
        })

      // Each run pinned the seed, and each publish is on the default
      // branch: one commit of each run, with its file.
      const bare = join(remotes, contexts[0] ?? "")
      const runIds = handles.map((handle) => handle.workflowRun.id)
      const trailers = git(
        bare,
        "log",
        "--format=%(trailers:key=Ctxpipe-Run,valueonly)",
        `${pinned[0]}..main`,
      )
        .split("\n")
        .filter(Boolean)
      expect(trailers.sort()).toEqual([...runIds].sort())
      const files = git(bare, "ls-tree", "-r", "--name-only", "main")
      for (const i of parallelNames.keys())
        expect(files).toContain(`knowledge/services/parallel-${i}.md`)

      // One publish of the Workspace runs at a time, and it replays its
      // delta on the tip of now: no publish lost a push race. Without the
      // lease, each publish after the first lost its first push, and one of
      // the 5 lost each of its 3 attempts.
      const raced = await getSystemDb().execute<{ count: string }>(sql`
        select count(*) from openworkflow.step_attempts step
        join openworkflow.workflow_runs publish
          on publish.namespace_id = step.namespace_id
          and publish.id = step.workflow_run_id
        where step.namespace_id = ${openWorkflowNamespaceId()}
          and publish.workflow_name = 'workspace-write-extract-ingest'
          and publish.input->'ingest'->>'runId' in (${sql.join(
            runIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          and step.step_name like 'refresh-raced-revision%'
          and step.status = 'completed'
      `)
      expect(Number(raced.rows[0]?.count)).toBe(0)
    },
  )
})
