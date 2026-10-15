import { expect, it, vi } from "vitest"
import { parse, stringify } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

// The publish pipeline switch is a committed value (`legacy` until the
// switch); the unlink retraction runs only while it is `v2`.
vi.mock("../ingestion/ingestion-v2-config.js", async (original) => ({
  ...(await original<typeof import("../ingestion/ingestion-v2-config.js")>()),
  ingestionPublishPipeline: () => "v2",
}))

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

it(
  "retracts the files and claims of an unlinked repository in one host commit",
  { timeout: 90_000 },
  async () => {
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
                },
                log,
              ),
            ),
          ).toEqual({ started: true })
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(jobId),
                ),
              { timeout: 30_000 },
            )
            .toMatchObject({ status: "completed" })
        }
        try {
          const { workspaceLinkUnlink } = await import(
            "../../openworkflow/workflows/workspace-link-unlink.js"
          )
          runner.implementWorkflow(
            workspaceLinkUnlink.spec,
            workspaceLinkUnlink.fn,
          )
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

          await run(`wjob_${f.id}_unlink`, "unlink")
          // One host commit after the link.
          expect(git("rev-list", "--count", `${linked}..refs/heads/main`)).toBe(
            "1",
          )
          expect(
            git("diff", "--name-status", linked, "refs/heads/main")
              .split("\n")
              .sort(),
          ).toEqual(
            [
              "M\tknowledge/instructions/unit-testing.md",
              "D\tknowledge/services/billing.md",
              "D\tknowledge/services/invoices.md",
              "M\tknowledge/services/ledger.md",
              `D\t${declaration}`,
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
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)
