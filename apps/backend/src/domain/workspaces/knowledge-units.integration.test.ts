import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { asc, eq } from "drizzle-orm"
import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceKnowledgeUnits } from "../../db/schema/workspaces.js"
import { captureWorkspaceRevision } from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"

const FIRST_COMMIT = "2026-03-01T10:00:00.000Z"
const SECOND_COMMIT = "2026-04-02T11:30:00.000Z"

function readUnits(f: NativeHydrationFixture) {
  const units = workspaceKnowledgeUnits
  return withOrgDbContext(f.org.id, (db) =>
    db
      .select({
        path: units.path,
        title: units.title,
        source: units.source,
        updatedAt: units.updatedAt,
      })
      .from(units)
      .where(eq(units.workspaceId, f.workspaceId))
      .orderBy(asc(units.path)),
  )
}

/** Commit one changed file at a fixed time and capture its revision. */
async function commitChange(
  f: NativeHydrationFixture,
  input: { path: string; body: string; previousSha: string; date: string },
) {
  writeFileSync(join(f.directory, input.path), input.body)
  f.git("add", "--", input.path)
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "Edit one section",
    ],
    {
      cwd: f.directory,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: input.date,
        GIT_COMMITTER_DATE: input.date,
      },
    },
  )
  const nextSha = f.git("rev-parse", "HEAD")
  f.git("push", f.remote, "HEAD:main")
  const revision = await withOrgIdContext(f.org, () =>
    captureWorkspaceRevision({
      workspaceId: f.workspaceId,
      expected: {
        generation: 1,
        url: f.workspaceUrl,
        sha: input.previousSha,
        defaultBranch: "main",
        githubConnectionId: null,
      },
      tip: { sha: nextSha, branch: "main" },
    }),
  )
  if (!revision) throw new Error("Fixture revision was not captured")
  return { nextSha, revision }
}

async function hydrate(
  f: NativeHydrationFixture,
  revision: Parameters<typeof workspaceHydrate.fn>[0]["input"]["revision"],
) {
  const run = await f.runner.runWorkflow(workspaceHydrate.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision,
  })
  return run.result({ timeoutMs: 30_000 })
}

const ALPHA = "# Alpha\nAlpha text."
const BETA = "## Beta\nBeta text."

it(
  "sets title, source, and the last commit time for each mirror kind and an authored unit",
  { timeout: 60_000 },
  async () =>
    withNativeHydrationFixture(
      {
        initialCommitDate: FIRST_COMMIT,
        files: [
          {
            path: "confluence/spaces/ENG/runbook--1.md",
            body: "---\ntitle: Runbook\n---\nSteps.\n",
          },
          {
            path: "github/pulls/fixture/api/7--fix-login.md",
            body: "# Fix login\nBody.\n",
          },
          { path: "knowledge/payments.md", body: "Intro.\n\n## Payments\n" },
          { path: "linear/issues/PAY-1.md", body: "# PAY-1 Refunds\n" },
          {
            path: "notion/pages/root--p1/index.md",
            body: "---\ntitle: Roadmap\n---\n# Other\n",
          },
          { path: "pagerduty/incidents/12--P1.md", body: "# Outage 12\n" },
          { path: "slack/channels/eng--C1/index.md", body: "No heading.\n" },
        ],
      },
      async (f) => {
        await f.publish()
        const at = new Date(FIRST_COMMIT)
        expect(
          (await readUnits(f)).map(({ path, title, source, updatedAt }) => ({
            path,
            title,
            source,
            updatedAt,
          })),
        ).toEqual([
          {
            path: "confluence/spaces/ENG/runbook--1.md",
            title: "Runbook",
            source: "confluence",
            updatedAt: at,
          },
          {
            path: "github/pulls/fixture/api/7--fix-login.md",
            title: "Fix login",
            source: "github",
            updatedAt: at,
          },
          {
            path: "knowledge/payments.md",
            title: "Payments",
            source: "authored",
            updatedAt: at,
          },
          {
            path: "linear/issues/PAY-1.md",
            title: "PAY-1 Refunds",
            source: "linear",
            updatedAt: at,
          },
          {
            path: "notion/pages/root--p1/index.md",
            title: "Roadmap",
            source: "notion",
            updatedAt: at,
          },
          {
            path: "pagerduty/incidents/12--P1.md",
            title: "Outage 12",
            source: "pagerduty",
            updatedAt: at,
          },
          {
            path: "slack/channels/eng--C1/index.md",
            title: null,
            source: "slack",
            updatedAt: at,
          },
        ])
      },
    ),
)

it(
  "sets the time of each unit from the last commit of its own file",
  { timeout: 120_000 },
  async () =>
    withNativeHydrationFixture(
      {
        initialCommitDate: FIRST_COMMIT,
        files: [
          { path: "a.md", body: `${ALPHA}\n${BETA}\n` },
          { path: "b.md", body: `${ALPHA}\n` },
        ],
      },
      async (f) => {
        await f.publish()
        const second = await commitChange(f, {
          path: "a.md",
          body: `${ALPHA}\n## Beta\nBeta text, now longer.\n`,
          previousSha: f.sha,
          date: SECOND_COMMIT,
        })
        expect(await hydrate(f, second.revision)).toMatchObject({
          hydrated: true,
          units: 2,
        })
        expect(
          (await readUnits(f)).map(({ path, title, updatedAt }) => ({
            path,
            title,
            updatedAt,
          })),
        ).toEqual([
          { path: "a.md", title: "Alpha", updatedAt: new Date(SECOND_COMMIT) },
          { path: "b.md", title: "Alpha", updatedAt: new Date(FIRST_COMMIT) },
        ])
      },
    ),
)
