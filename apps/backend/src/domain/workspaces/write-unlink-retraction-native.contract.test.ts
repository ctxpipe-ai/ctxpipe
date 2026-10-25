import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { parse, stringify } from "yaml"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { enqueueSourceProjectionFollowUps } from "../workspace-sources/enqueue.js"
import { projectWorkspaceSources } from "../workspace-sources/project.js"
import {
  WORKSPACE_FORMAT_PATH,
  workspaceFormatFile,
} from "./workspace-format.js"

// The fixture answers GitHub for each repository of the `fixture` owner.
const UNLINKED = "https://github.com/fixture/billing"
const ROOT = "context"
const UNLINKED_SOURCE = "sources/github/fixture/billing.md"
const OTHER_SOURCE = "sources/github/fixture/ledger.md"
const SOURCES_YAML = ".ctxpipe/sources.yaml"
const HUMAN =
  "<!-- ctxpipe:human -->\nA note that a human wrote.\n<!-- /ctxpipe:human -->\n"

function doc(front: Record<string, unknown>, body: string): string {
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${body}`
}

/** A GitHub source file; the fixture puts in its connection id. */
const sourceFile = (repository: string) =>
  `---\nprovider: github\nconnection: "{{connectionId}}"\nrepository: ${repository}\n---\n`

const host = (sources: string[]) => ({
  generated_by: "ctxpipe-extract",
  sources,
  source_sha: "a".repeat(40),
  skill: "codebase",
  bundle: "b1",
})
const legacyOpen = {
  to: "../libraries/zod.md",
  predicate: "DEPENDS_ON",
  source: `${UNLINKED}.git#package.json`,
  valid_from: "2025-01-01T00:00:00.000Z",
  evidence: { kind: "legacy" },
}
const legacyClosed = {
  to: "../libraries/yup.md",
  predicate: "DEPENDS_ON",
  source: `${UNLINKED}.git#package.json`,
  valid_from: "2024-01-01T00:00:00.000Z",
  valid_to: "2024-06-01T00:00:00.000Z",
  evidence: { kind: "legacy" },
}
const otherClaim = {
  to: "../libraries/zod.md",
  predicate: "USES",
  evidence: { path: "src/index.ts", kind: "script" },
  confidence: 0.7,
}
const areaBody = [
  "# Unit testing",
  "",
  "## Summary",
  "",
  "How the code is tested.",
  "",
  "## Rules",
  "",
  "- Use vitest.",
  "  - topic: `runner` = `vitest` (core)",
  `  - source \`${UNLINKED_SOURCE}\`, documented: \`README.md\``,
  `  - source \`${OTHER_SOURCE}\`, documented: \`docs/testing.md\``,
  "- Name tests after the behavior.",
  "  - topic: `naming` = `behavior`",
  `  - source \`${UNLINKED_SOURCE}\`, documented: \`CONTRIBUTING.md\``,
  "",
  "## Repository notes",
  "",
  `- \`${OTHER_SOURCE}\`: Ledger runs tests locally.`,
  `- \`${UNLINKED_SOURCE}\`: Billing runs tests in CI.`,
  "",
].join("\n")
const ledgerBody = `# Ledger\n\nText.\n\n${HUMAN}`

// Two linked repositories, and the published ingestion v2 output of both,
// below the Workspace root folder of a Workspace at format 3.
const published = [
  { path: WORKSPACE_FORMAT_PATH, body: workspaceFormatFile(3).content },
  { path: UNLINKED_SOURCE, body: sourceFile("fixture/billing") },
  {
    path: OTHER_SOURCE,
    body: sourceFile("fixture/ledger"),
  },
  {
    path: "knowledge/services/billing.md",
    body: doc(
      {
        kind: "Service",
        name: "Billing",
        ...host([UNLINKED_SOURCE]),
        root: ".",
      },
      "# Billing\n\nExtracted text.\n",
    ),
  },
  {
    // A file that the ownership migration moved to ingestion v2.
    path: "knowledge/services/invoices.md",
    body: doc(
      {
        kind: "Service",
        name: "Invoices",
        claims: [legacyOpen, legacyClosed],
        ...host([UNLINKED_SOURCE]),
      },
      "# Invoices\n",
    ),
  },
  {
    path: "knowledge/services/ledger.md",
    body: doc(
      {
        kind: "Service",
        name: "Ledger",
        claims: [legacyOpen, legacyClosed, otherClaim],
        ...host([OTHER_SOURCE]),
      },
      ledgerBody,
    ),
  },
  {
    path: "knowledge/instructions/unit-testing.md",
    body: `${doc(
      {
        kind: "InstructionUnit",
        name: "Unit testing",
        ...host([UNLINKED_SOURCE, OTHER_SOURCE]),
      },
      areaBody,
    )}\n${HUMAN}`,
  },
].map((file) => ({ ...file, path: `${ROOT}/${file.path}` }))

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

/**
 * A person pushes a commit to the default branch of the Workspace
 * repository: a merged pull request. Paths are below the root folder; null
 * deletes the file.
 */
function humanPush(f: Fixture, files: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), "unlink-retraction-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Person",
        GIT_AUTHOR_EMAIL: "person@example.com",
        GIT_COMMITTER_NAME: "Person",
        GIT_COMMITTER_EMAIL: "person@example.com",
      },
    }).trim()
  try {
    git("clone", "--quiet", f.remote, ".")
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, ROOT, path)
      if (content === null) rmSync(full)
      else {
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(
          full,
          content.replaceAll("{{connectionId}}", f.connectionId),
        )
      }
    }
    git("add", "-A")
    git("commit", "--quiet", "-m", "Merge a pull request")
    git("push", "--quiet", "origin", "HEAD:refs/heads/main")
    return git("rev-parse", "HEAD")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Project the sources at the tip of the remote and run the follow-ups, as
 * hydrate does for a merged revision while ingestion v2 publishes. Gives a
 * replay of the follow-ups of this projection.
 */
async function projectTip(
  f: Fixture,
  at?: string,
): Promise<() => Promise<void>> {
  const git = (...args: string[]) => f.git("--git-dir", f.remote, ...args)
  const sha = at ?? git("rev-parse", "refs/heads/main")
  const paths = git("ls-tree", "-r", "--name-only", sha, `${ROOT}/sources/`)
    .split("\n")
    .filter(Boolean)
  const files = paths.map((path) => ({
    path: path.slice(ROOT.length + 1),
    text: `${git("show", `${sha}:${path}`)}\n`,
  }))
  const yaml = git("ls-tree", "--name-only", sha, `${ROOT}/${SOURCES_YAML}`)
    ? `${git("show", `${sha}:${ROOT}/${SOURCES_YAML}`)}\n`
    : null
  const projected = await withOrgIdContext(f.org, () =>
    projectWorkspaceSources({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      revision: sha,
      text: yaml,
      files,
      env: parseEnv(process.env),
    }),
  )
  const followUps = () =>
    enqueueSourceProjectionFollowUps({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      revision: sha,
      projected,
      format: 3,
    })
  await followUps()
  return followUps
}

/**
 * Link both repositories, then merge `unlink` and project it. The worker
 * starts after the projection of the unlink.
 */
async function mergeThenRetract(
  options: {
    /** Runs when the retraction asks for its push credential. */
    beforePush?: (f: Fixture) => void
    /** Merged one by one before the unlink; none of them retracts. */
    before?: Array<Record<string, string | null>>
    /** The unlink pull request. Default: delete the source file. */
    unlink?: Record<string, string | null>
    /** Runs after the projection of the unlink, before the worker starts. */
    afterUnlink?: (f: Fixture) => void
    /** Project the unlink by a hydrate run, not by a direct call. */
    hydrate?: true
    /** The unlink queues no retraction. */
    keeps?: true
  },
  check: (input: {
    f: Fixture
    git: (...args: string[]) => string
    show: (path: string) => string
    merged: string
    jobs: () => Promise<Array<{ id: string; status: string | undefined }>>
    /** The results of the finished retraction runs. */
    results: () => Promise<unknown[]>
    /** Run the follow-ups of the projection of the unlink again. */
    replay: () => Promise<void>
  }) => Promise<void> | void,
) {
  await withNativeHydrationFixture(
    {
      github: true,
      githubWriteView: "writable",
      writeStatus: "writable",
      rootPath: ROOT,
      files: published,
    },
    async (f) => {
      await f.handle.cancel()
      // The cache that hydrate writes; the admission of a retraction reads it.
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(workspaces)
          .set({ formatVersion: 3 })
          .where(eq(workspaces.id, f.workspaceId)),
      )
      const { beforePush } = options
      if (beforePush) f.onWriteCredentialRequest(async () => beforePush(f))
      const { BackendPostgres } = await import("openworkflow/postgres")
      const { OpenWorkflow } = await import("openworkflow")
      const backend = await BackendPostgres.connect(f.databaseUrl, {
        namespaceId: openWorkflowNamespaceId(),
        runMigrations: false,
      })
      const runner = new OpenWorkflow({ backend })
      let worker: ReturnType<typeof runner.newWorker> | undefined
      const git = (...args: string[]) => f.git("--git-dir", f.remote, ...args)
      const show = (path: string) =>
        git("show", `refs/heads/main:${ROOT}/${path}`)
      const jobs = async () => {
        const runs = (await backend.listWorkflowRuns({ limit: 1000 })).data
        return Promise.all(
          runs
            .filter(
              (run) =>
                run.workflowName === "workspace-write-unlink-retraction" &&
                (run.input as { workspaceId?: string }).workspaceId ===
                  f.workspaceId,
            )
            .map(async (run) => {
              const id = (run.input as { jobId: string }).jobId
              const job = await withOrgIdContext(f.org, () =>
                reconcileWorkspaceWriteJob(id),
              )
              return { id, status: job?.status }
            }),
        )
      }
      const results = async () =>
        (await backend.listWorkflowRuns({ limit: 1000 })).data
          .filter(
            (run) =>
              run.workflowName === "workspace-write-unlink-retraction" &&
              (run.input as { workspaceId?: string }).workspaceId ===
                f.workspaceId,
          )
          .map((run) => run.output)
      try {
        const { defineWorkspaceUnlinkRetractionWorkflow } =
          await import("../../openworkflow/workflows/workspace-unlink-retraction.js")
        const workflow = defineWorkspaceUnlinkRetractionWorkflow()
        runner.implementWorkflow(workflow.spec, workflow.fn)
        const { defineWorkspaceHydrateWorkflow } =
          await import("../../openworkflow/workflows/workspace-hydrate.js")
        const hydrate = defineWorkspaceHydrateWorkflow()
        runner.implementWorkflow(hydrate.spec, hydrate.fn)

        await projectTip(f)
        for (const push of options.before ?? []) {
          humanPush(f, push)
          await projectTip(f)
        }
        // Both repositories stay named, so nothing retracts.
        expect(await jobs()).toEqual([])

        // The unlink pull request deletes the source file, and merges.
        const merged = humanPush(
          f,
          options.unlink ?? { [UNLINKED_SOURCE]: null },
        )
        let replay = async () => {}
        if (options.hydrate) {
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          const run = await runner.runWorkflow(hydrate.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: await f.resolveRevision(true),
          })
          expect(await run.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
          })
        } else replay = await projectTip(f)
        if (options.keeps) expect(await jobs()).toEqual([])
        else options.afterUnlink?.(f)
        if (!worker) {
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
        }
        if (!options.keeps)
          await expect
            .poll(jobs, { timeout: 60_000 })
            .toEqual([{ id: expect.any(String), status: "completed" }])
        await check({ f, git, show, merged, jobs, results, replay })
      } finally {
        await worker?.stop()
        await backend.stop()
      }
    },
  )
}

/** The host commit retracts what the repository owns, below the root folder. */
function expectRetraction(input: {
  git: (...args: string[]) => string
  show: (path: string) => string
  from: string
}) {
  const { git, show } = input
  expect(
    git("diff", "--name-status", input.from, "refs/heads/main")
      .split("\n")
      .sort(),
  ).toEqual(
    [
      `M\t${ROOT}/knowledge/instructions/unit-testing.md`,
      `D\t${ROOT}/knowledge/services/billing.md`,
      `D\t${ROOT}/knowledge/services/invoices.md`,
      `M\t${ROOT}/knowledge/services/ledger.md`,
    ].sort(),
  )

  const ledger = show("knowledge/services/ledger.md")
  const ledgerFront = parse(ledger.split("---\n")[1] ?? "")
  expect(ledgerFront.sources).toEqual([OTHER_SOURCE])
  // The open claim closes; the closed claim keeps its dates.
  expect(ledgerFront.claims).toEqual([
    { ...legacyOpen, valid_to: expect.any(String) },
    legacyClosed,
    otherClaim,
  ])
  expect(`${ledger}\n`.endsWith(ledgerBody)).toBe(true)

  const area = show("knowledge/instructions/unit-testing.md")
  expect(parse(area.split("---\n")[1] ?? "").sources).toEqual([OTHER_SOURCE])
  expect(area).not.toContain(UNLINKED_SOURCE)
  expect(area).toContain(`source \`${OTHER_SOURCE}\`, documented`)
  expect(area).toContain("Ledger runs tests locally")
  expect(area).not.toContain("Name tests after the behavior")
  expect(`${area}\n`.endsWith(`\n${HUMAN}`)).toBe(true)
}

it(
  "retracts a repository in one host commit after its unlink pull request merges, and not while its source is only invalid",
  { timeout: 150_000 },
  async () => {
    await mergeThenRetract(
      {
        // CTX-710: an entry that became invalid keeps the files.
        before: [
          {
            [UNLINKED_SOURCE]:
              '---\nprovider: github\nconnection: "{{connectionId}}"\nrepository: 5\n---\n',
          },
        ],
      },
      ({ git, show, merged }) => {
        // One host commit after the merge.
        expect(git("rev-list", "--count", `${merged}..refs/heads/main`)).toBe(
          "1",
        )
        expect(git("log", "-1", "--format=%an", "refs/heads/main")).not.toBe(
          "Person",
        )
        expectRetraction({ git, show, from: merged })
      },
    )
  },
)

it(
  "retracts nothing when the upgrade pull request is reverted before the job plans",
  { timeout: 150_000 },
  async () => {
    let reverted = ""
    await mergeThenRetract(
      {
        // The tree goes back to format 2: the old pipeline owns it again.
        afterUnlink: (f) => {
          reverted = humanPush(f, {
            [WORKSPACE_FORMAT_PATH]: workspaceFormatFile(2).content,
          })
        },
      },
      ({ git }) => {
        expect(reverted).not.toBe("")
        expect(git("rev-parse", "refs/heads/main")).toBe(reverted)
      },
    )
  },
)

it(
  "plans the retraction again on the new tip after it loses the push race, and retracts a file that came in the race",
  { timeout: 150_000 },
  async () => {
    let raced = ""
    await mergeThenRetract(
      {
        // A person pushes a new file of the repository before the first
        // push.
        beforePush: (f) => {
          if (!raced)
            raced = humanPush(f, {
              "knowledge/services/payments.md": doc(
                {
                  kind: "Service",
                  name: "Payments",
                  ...host([UNLINKED_SOURCE]),
                  root: "payments",
                },
                "# Payments\n",
              ),
            })
        },
      },
      ({ git, show }) => {
        expect(raced).not.toBe("")
        // The retraction has the person's commit as its parent.
        expect(git("rev-parse", "refs/heads/main^")).toBe(raced)
        expectRetraction({ git, show, from: `${raced}^` })
        expect(
          git(
            "ls-tree",
            "--name-only",
            "refs/heads/main",
            `${ROOT}/knowledge/services/`,
          ),
        ).not.toContain("payments.md")
      },
    )
  },
)

it(
  "keeps a repository whose source file moves to another path",
  { timeout: 150_000 },
  async () => {
    await mergeThenRetract(
      {
        unlink: {
          [UNLINKED_SOURCE]: null,
          "sources/github/team/billing.md": sourceFile("fixture/billing"),
        },
        keeps: true,
      },
      ({ git, merged }) => {
        expect(git("rev-parse", "refs/heads/main")).toBe(merged)
      },
    )
  },
)

it(
  "retracts nothing when a source names the repository again at the tip before the job plans",
  { timeout: 150_000 },
  async () => {
    let named = ""
    await mergeThenRetract(
      {
        afterUnlink: (f) => {
          named = humanPush(f, {
            [UNLINKED_SOURCE]: sourceFile("fixture/billing"),
          })
        },
      },
      ({ git }) => {
        expect(named).not.toBe("")
        expect(git("rev-parse", "refs/heads/main")).toBe(named)
      },
    )
  },
)

it(
  "queues no second job for a second projection or a replay of the same revision",
  { timeout: 150_000 },
  async () => {
    await mergeThenRetract(
      {},
      async ({ f, git, show, merged, jobs, replay }) => {
        expectRetraction({ git, show, from: merged })
        const [job] = await jobs()
        // A second projection of the merged revision finds no change.
        await projectTip(f, merged)
        // A replay of the follow-ups (a retried hydrate step) keeps the job id.
        await replay()
        expect(await jobs()).toEqual([job])
      },
    )
  },
)

it(
  "keeps a repository that a sources.yaml entry still holds after the entry became invalid",
  { timeout: 150_000 },
  async () => {
    const yaml = (repositories: string) =>
      [
        "version: 1",
        "sources:",
        "  - id: web",
        "    provider: github",
        '    connection: "{{connectionId}}"',
        `    repositories: ${repositories}`,
        "",
      ].join("\n")
    await mergeThenRetract(
      {
        before: [
          { [SOURCES_YAML]: yaml("[fixture/billing]") },
          // The entry keeps its id, but it no longer parses.
          { [SOURCES_YAML]: yaml("[5]") },
        ],
        keeps: true,
      },
      async ({ f, git, merged, jobs }) => {
        expect(git("rev-parse", "refs/heads/main")).toBe(merged)
        // A job that a person or an older projection queued also keeps it.
        const { enqueueWriteJob } =
          await import("../../openworkflow/enqueue-workspace-write-commit.js")
        const started = await withOrgIdContext(f.org, () =>
          enqueueWriteJob(
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              kind: "unlink_retraction",
              jobId: `wjob_retract_direct_${f.id}`,
              retractRepositoryUrl: UNLINKED,
              retractSourcePath: UNLINKED_SOURCE,
            },
            {
              error: (error) => {
                throw error
              },
            },
          ),
        )
        expect(started).toEqual({ started: true })
        await expect
          .poll(jobs, { timeout: 60_000 })
          .toEqual([{ id: `wjob_retract_direct_${f.id}`, status: "completed" }])
        expect(git("rev-parse", "refs/heads/main")).toBe(merged)
      },
    )
  },
)

it(
  "queues the retraction from the projection step of a hydrate run",
  { timeout: 150_000 },
  async () => {
    await mergeThenRetract({ hydrate: true }, ({ git, show, merged }) => {
      expectRetraction({ git, show, from: merged })
    })
  },
)

it(
  "leaves an old file outside the allowed knowledge folders unchanged, lists it in the job result, and finishes the rest",
  { timeout: 150_000 },
  async () => {
    const oldFile = doc(
      {
        kind: "Topic",
        generated_by: "ctxpipe",
        source: `${UNLINKED}.git#src/index.ts`,
      },
      "# Billing patterns\n",
    )
    await mergeThenRetract(
      {
        before: [{ "knowledge/patterns/billing.md": oldFile }],
      },
      async ({ git, show, merged, results }) => {
        // The rest of the retraction is done, and the old file is not touched.
        expectRetraction({ git, show, from: merged })
        expect(show("knowledge/patterns/billing.md")).toBe(oldFile.trimEnd())
        // The job row turns completed before the workflow run stores its output.
        await expect.poll(results, { timeout: 30_000 }).toEqual([
          expect.objectContaining({
            committed: true,
            skipped: [
              {
                path: "knowledge/patterns/billing.md",
                reason:
                  "Only the knowledge folders of the allowlist are allowed",
              },
            ],
          }),
        ])
      },
    )
  },
)
