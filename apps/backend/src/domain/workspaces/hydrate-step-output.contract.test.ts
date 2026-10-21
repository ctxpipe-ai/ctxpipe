import { readFileSync, renameSync } from "node:fs"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { listWorkspaceKnowledgeUnits } from "../../models/workspaces.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"

/**
 * Top-level `git fetch` commands that start a read of the tree: the fetch of
 * the tip commit from `origin`. The history fetch and the pack read of the
 * previous commit are not counted.
 */
function fullHistoryFetches(f: NativeHydrationFixture) {
  return readFileSync(f.gitTrace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(
      (event) =>
        event.event === "start" &&
        !event.sid.includes("/") &&
        event.argv.includes("fetch") &&
        event.argv.includes("origin") &&
        event.argv.includes("--depth"),
    )
}

// OpenWorkflow keeps each step output in one jsonb value and loads all of
// them on each replay. The markdown bodies must not go into a step output.
it(
  "hydrate keeps each step output small for a large markdown repository",
  { timeout: 120_000 },
  async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      path: `knowledge/document-${String(index).padStart(3, "0")}.md`,
      body: `# Document ${index}\n\n${"Body text of a large document. ".repeat(320)}\n`,
    }))
    const total = files.reduce((sum, file) => sum + file.body.length, 0)
    expect(total).toBeGreaterThan(2_000_000)
    await withNativeHydrationFixture({ files }, async (f) => {
      await f.publish()
      await withOrgIdContext(f.org, async () => {
        expect(
          (await listWorkspaceKnowledgeUnits(f.workspaceId)).units
            .map(({ path, body }) => ({ path, body }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(f.expected)
      })
      const steps = (
        await f.backend.listStepAttempts({
          workflowRunId: f.handle.workflowRun.id,
          limit: 1000,
        })
      ).data
      expect(steps.length).toBeGreaterThan(0)
      const sizes = steps.map((step) => ({
        name: step.stepName,
        bytes: JSON.stringify(step.output ?? null).length,
      }))
      expect(sizes.filter((step) => step.bytes > 100_000)).toEqual([])
    })
  },
)

it(
  "hydrate retries when the git read of the tree fails one time",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(
      { count: 2, traceGitCommands: true },
      async (f) => {
        const offline = `${f.remote}.offline`
        renameSync(f.remote, offline)
        const restore = (async () => {
          for (;;) {
            const run = await f.backend.getWorkflowRun({
              workflowRunId: f.handle.workflowRun.id,
            })
            if (run?.error) break
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          renameSync(offline, f.remote)
        })()
        await f.publish()
        await restore
        expect(fullHistoryFetches(f)).toHaveLength(2)
      },
    )
  },
)

it(
  "hydrate does not read the tree again when a step after the write plan retries",
  { timeout: 120_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        traceGitCommands: true,
        // Format 3: hydrate plans the claim writes only there.
        format: 3,
        files: [
          { path: "knowledge/a.md", body: "# A\n[B](b.md)\n" },
          {
            path: "knowledge/b.md",
            body: "---\nclaims:\n  - to: a.md\n---\n# B\n",
          },
        ],
      },
      async (f) => {
        // Postgres refuses the first write workflow that hydrate admits. A
        // sequence is not transactional, so the second admission passes.
        const { Pool } = await import("pg")
        const { ownerUrlForMigrate } = await import(
          "../../db/owner-migrate-url.js"
        )
        const owner = new Pool({
          connectionString: ownerUrlForMigrate(f.databaseUrl),
        })
        const fault = `ctx529_fault_${f.id.replace(/[^a-z0-9]/gi, "_")}`
        await owner.query(`
          create sequence public.${fault}_seq;
          create function public.${fault}() returns trigger
          language plpgsql as $$
          begin
            if new.workflow_name like 'workspace-write-%'
              and new.input->>'workspaceId' = '${f.workspaceId}'
              and nextval('public.${fault}_seq') = 1 then
              raise exception 'Admission is unavailable one time';
            end if;
            return new;
          end $$;
          create trigger ${fault} before insert on openworkflow.workflow_runs
            for each row execute function public.${fault}();
        `)
        try {
          // The retry replays the body after activation, so its result is a
          // noop. The units show that the first execution published.
          await f.worker.start()
          await f.handle.result({ timeoutMs: 30_000 })
        } finally {
          await owner.query(`
            drop trigger ${fault} on openworkflow.workflow_runs;
            drop function public.${fault}();
            drop sequence public.${fault}_seq;
          `)
          await owner.end()
        }
        const steps = (
          await f.backend.listStepAttempts({
            workflowRunId: f.handle.workflowRun.id,
            limit: 1000,
          })
        ).data
        expect(
          steps
            .filter((step) => step.status === "failed")
            .map((step) => step.stepName),
        ).toEqual([expect.stringMatching(/^admit-/)])
        expect(fullHistoryFetches(f)).toHaveLength(1)
        await withOrgIdContext(f.org, async () => {
          expect(
            (await listWorkspaceKnowledgeUnits(f.workspaceId)).units
              .map(({ path }) => path)
              .sort(),
          ).toEqual(["knowledge/a.md", "knowledge/b.md"])
        })
      },
    )
  },
)
