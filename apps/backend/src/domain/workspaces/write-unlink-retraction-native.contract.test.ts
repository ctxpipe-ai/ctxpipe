import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, it } from "vitest"
import { parse, stringify } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import type { IngestionPublishPipeline } from "../ingestion/ingestion-v2-config.js"
import { enqueueSourceProjectionFollowUps } from "../workspace-sources/enqueue.js"
import { projectWorkspaceSources } from "../workspace-sources/project.js"

// The fixture answers GitHub for each repository of the `fixture` owner.
const UNLINKED = "https://github.com/fixture/billing"
const OTHER = "https://github.com/fixture/ledger"
const ROOT = "context"
const UNLINKED_SOURCE = "sources/github/fixture/billing.md"
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
  `  - source \`${UNLINKED}\`, documented: \`README.md\``,
  `  - source \`${OTHER}\`, documented: \`docs/testing.md\``,
  "- Name tests after the behavior.",
  "  - topic: `naming` = `behavior`",
  `  - source \`${UNLINKED}\`, documented: \`CONTRIBUTING.md\``,
  "",
  "## Repository notes",
  "",
  `- \`${OTHER}\`: Ledger runs tests locally.`,
  `- \`${UNLINKED}\`: Billing runs tests in CI.`,
  "",
].join("\n")
const ledgerBody = `# Ledger\n\nText.\n\n${HUMAN}`

// Two linked repositories, and the published ingestion v2 output of both,
// below the Workspace root folder.
const published = [
  { path: UNLINKED_SOURCE, body: sourceFile("fixture/billing") },
  {
    path: "sources/github/fixture/ledger.md",
    body: sourceFile("fixture/ledger"),
  },
  {
    path: "knowledge/services/billing.md",
    body: doc(
      { kind: "Service", name: "Billing", ...host([UNLINKED]), root: "." },
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
        ...host([UNLINKED]),
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
        ...host([OTHER]),
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
        ...host([UNLINKED, OTHER]),
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
 * hydrate does for a merged revision while ingestion v2 publishes.
 */
async function projectTip(f: Fixture): Promise<string> {
  const git = (...args: string[]) => f.git("--git-dir", f.remote, ...args)
  const sha = git("rev-parse", "refs/heads/main")
  const paths = git("ls-tree", "-r", "--name-only", sha, `${ROOT}/sources/`)
    .split("\n")
    .filter(Boolean)
  const files = paths.map((path) => ({
    path: path.slice(ROOT.length + 1),
    text: `${git("show", `${sha}:${path}`)}\n`,
  }))
  const projected = await withOrgIdContext(f.org, () =>
    projectWorkspaceSources({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      revision: sha,
      text: null,
      files,
      env: parseEnv(process.env),
    }),
  )
  await enqueueSourceProjectionFollowUps({
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision: sha,
    projected,
    publishPipeline: "v2",
  })
  return sha
}

/**
 * Link both repositories, then merge `merge` and project it. `committed` is
 * the switch value that the push step of the retraction reads.
 */
async function mergeThenRetract(
  options: {
    committed: (f: Fixture) => IngestionPublishPipeline
    /** Merged before the unlink; the projection must not retract for it. */
    before?: Record<string, string | null>
  },
  check: (input: {
    f: Fixture
    git: (...args: string[]) => string
    show: (path: string) => string
    merged: string
    jobs: () => Promise<Array<{ id: string; status: string | undefined }>>
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
      try {
        const { defineWorkspaceUnlinkRetractionWorkflow } = await import(
          "../../openworkflow/workflows/workspace-unlink-retraction.js"
        )
        const workflow = defineWorkspaceUnlinkRetractionWorkflow({
          committedPipeline: () => options.committed(f),
        })
        runner.implementWorkflow(workflow.spec, workflow.fn)
        worker = runner.newWorker({ concurrency: 1 })
        await worker.start()

        await projectTip(f)
        if (options.before) {
          humanPush(f, options.before)
          await projectTip(f)
        }
        // Both repositories stay named, so nothing retracts.
        expect(await jobs()).toEqual([])

        // The unlink pull request deletes the source file, and merges.
        const merged = humanPush(f, { [UNLINKED_SOURCE]: null })
        await projectTip(f)
        await expect
          .poll(jobs, { timeout: 60_000 })
          .toEqual([{ id: expect.any(String), status: "completed" }])
        await check({ f, git, show, merged, jobs })
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
  expect(ledgerFront.sources).toEqual([OTHER])
  // The open claim closes; the closed claim keeps its dates.
  expect(ledgerFront.claims).toEqual([
    { ...legacyOpen, valid_to: expect.any(String) },
    legacyClosed,
    otherClaim,
  ])
  expect(`${ledger}\n`.endsWith(ledgerBody)).toBe(true)

  const area = show("knowledge/instructions/unit-testing.md")
  expect(parse(area.split("---\n")[1] ?? "").sources).toEqual([OTHER])
  expect(area).not.toContain(UNLINKED)
  expect(area).toContain(`source \`${OTHER}\`, documented`)
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
        committed: () => "v2",
        // CTX-710: an entry that became invalid keeps the files.
        before: {
          [UNLINKED_SOURCE]:
            '---\nprovider: github\nconnection: "{{connectionId}}"\nrepository: 5\n---\n',
        },
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
  "plans the retraction again when the switch flips to legacy before the push, and pushes nothing",
  { timeout: 150_000 },
  async () => {
    let reads = 0
    await mergeThenRetract(
      {
        committed: () => {
          reads++
          return "legacy"
        },
      },
      ({ git, merged }) => {
        // The push step read the flip once; the plan under legacy is empty.
        expect(reads).toBe(1)
        expect(git("rev-parse", "refs/heads/main")).toBe(merged)
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
        // The first push step reads the switch, and then a person pushes a
        // new file of the repository before the push.
        committed: (f) => {
          if (!raced)
            raced = humanPush(f, {
              "knowledge/services/payments.md": doc(
                {
                  kind: "Service",
                  name: "Payments",
                  ...host([UNLINKED]),
                  root: "payments",
                },
                "# Payments\n",
              ),
            })
          return "v2"
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
