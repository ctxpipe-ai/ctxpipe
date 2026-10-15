import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { parse, stringify } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import type { IngestionPublishPipeline } from "../ingestion/ingestion-v2-config.js"

const UNLINKED = "https://github.com/acme/billing"
const OTHER = "https://github.com/acme/ledger"
const HUMAN =
  "<!-- ctxpipe:human -->\nA note that a human wrote.\n<!-- /ctxpipe:human -->\n"

function doc(front: Record<string, unknown>, body: string): string {
  return `---\n${stringify(front, { lineWidth: 0 })}---\n${body}`
}

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

// The published ingestion v2 output of two source repositories.
const published = [
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
]

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

/** A person pushes `files` to the default branch of the Workspace repository. */
function humanPush(f: Fixture, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "unlink-race-"))
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
    for (const [path, content] of Object.entries(files))
      writeFileSync(join(dir, path), content)
    git("add", "-A")
    git("commit", "--quiet", "-m", "A person adds a file")
    git("push", "--quiet", "origin", "HEAD:refs/heads/main")
    return git("rev-parse", "HEAD")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Link the repository, then unlink it. The unlink is queued under `queued`;
 * `committed` is the switch value that its push step reads.
 */
async function linkThenUnlink(
  options: {
    queued: IngestionPublishPipeline
    committed: (f: Fixture) => IngestionPublishPipeline
  },
  check: (input: {
    f: Fixture
    git: (...args: string[]) => string
    show: (path: string) => string
    linked: string
    declaration: string
  }) => void,
) {
  await withNativeHydrationFixture(
    {
      github: true,
      githubWriteView: "writable",
      writeStatus: "writable",
      files: published,
    },
    async (f) => {
      const { BackendPostgres } = await import("openworkflow/postgres")
      const { OpenWorkflow } = await import("openworkflow")
      const backend = await BackendPostgres.connect(f.databaseUrl, {
        namespaceId: openWorkflowNamespaceId(),
        runMigrations: false,
      })
      const runner = new OpenWorkflow({ backend })
      let worker: ReturnType<typeof runner.newWorker> | undefined
      const log = {
        error: (error: Error) => {
          throw error
        },
      }
      const git = (...args: string[]) => f.git("--git-dir", f.remote, ...args)
      const show = (path: string) => git("show", `refs/heads/main:${path}`)
      let unlinking = false
      const run = async (jobId: string, linkAction: "link" | "unlink") => {
        expect(
          await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                kind: "link_unlink",
                jobId,
                linkAction,
                linkGitUrl: `${UNLINKED}.git`,
                publishPipeline: options.queued,
              },
              log,
            ),
          ),
        ).toEqual({ started: true })
        await expect
          .poll(
            () =>
              withOrgIdContext(f.org, () => reconcileWorkspaceWriteJob(jobId)),
            { timeout: 30_000 },
          )
          .toMatchObject({ status: "completed" })
      }
      try {
        const { defineWorkspaceLinkUnlinkWorkflow } = await import(
          "../../openworkflow/workflows/workspace-link-unlink.js"
        )
        const workflow = defineWorkspaceLinkUnlinkWorkflow({
          committedPipeline: () =>
            unlinking ? options.committed(f) : options.queued,
        })
        runner.implementWorkflow(workflow.spec, workflow.fn)
        worker = runner.newWorker({ concurrency: 1 })
        await worker.start()

        await run(`wjob_${f.id}_link`, "link")
        const linked = git("rev-parse", "refs/heads/main")
        const declaration = git(
          "ls-tree",
          "-r",
          "--name-only",
          "refs/heads/main",
          "repositories/",
        )
        expect(declaration).toMatch(/^repositories\/[^/\n]+\.md$/)

        unlinking = true
        await run(`wjob_${f.id}_unlink`, "unlink")
        check({ f, git, show, linked, declaration })
      } finally {
        await worker?.stop()
        await backend.stop()
      }
    },
  )
}

/** The unlink commit retracts what the repository owns. */
function expectRetraction(input: {
  git: (...args: string[]) => string
  show: (path: string) => string
  from: string
  declaration: string
  alsoDeleted?: string[]
}) {
  const { git, show } = input
  expect(
    git("diff", "--name-status", input.from, "refs/heads/main")
      .split("\n")
      .sort(),
  ).toEqual(
    [
      "M\tknowledge/instructions/unit-testing.md",
      "D\tknowledge/services/billing.md",
      "D\tknowledge/services/invoices.md",
      "M\tknowledge/services/ledger.md",
      `D\t${input.declaration}`,
      ...(input.alsoDeleted ?? []).map((path) => `D\t${path}`),
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
  "retracts the files and claims of an unlinked repository in one host commit",
  { timeout: 90_000 },
  async () => {
    await linkThenUnlink(
      { queued: "v2", committed: () => "v2" },
      ({ git, show, linked, declaration }) => {
        // One host commit after the link.
        expect(git("rev-list", "--count", `${linked}..refs/heads/main`)).toBe(
          "1",
        )
        expectRetraction({ git, show, from: linked, declaration })
      },
    )
  },
)

it(
  "pushes only the declaration change of an unlink queued under v2 after a rollback to legacy",
  { timeout: 90_000 },
  async () => {
    await linkThenUnlink(
      { queued: "v2", committed: () => "legacy" },
      ({ git, linked, declaration }) => {
        expect(git("rev-list", "--count", `${linked}..refs/heads/main`)).toBe(
          "1",
        )
        expect(git("diff", "--name-status", linked, "refs/heads/main")).toBe(
          `D\t${declaration}`,
        )
      },
    )
  },
)

it(
  "adds the retraction to an unlink queued under legacy when the switch is v2 at push time",
  { timeout: 90_000 },
  async () => {
    await linkThenUnlink(
      { queued: "legacy", committed: () => "v2" },
      ({ git, show, linked, declaration }) => {
        expect(git("rev-list", "--count", `${linked}..refs/heads/main`)).toBe(
          "1",
        )
        expectRetraction({ git, show, from: linked, declaration })
      },
    )
  },
)

it(
  "plans the unlink again on the new tip after it loses the push race, and retracts a file that came in the race",
  { timeout: 120_000 },
  async () => {
    let human = ""
    await linkThenUnlink(
      {
        queued: "v2",
        // The first push step reads the switch, and then a person pushes a
        // new file of the repository before the push.
        committed: (f) => {
          if (!human)
            human = humanPush(f, {
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
      ({ git, show, declaration }) => {
        expect(human).not.toBe("")
        // The unlink commit has the person's commit as its parent.
        expect(git("rev-parse", "refs/heads/main^")).toBe(human)
        expectRetraction({
          git,
          show,
          from: `${human}^`,
          declaration,
        })
        expect(
          git(
            "ls-tree",
            "--name-only",
            "refs/heads/main",
            "knowledge/services/",
          ),
        ).not.toContain("payments.md")
      },
    )
  },
)
