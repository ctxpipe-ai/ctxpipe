import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"

it(
  "repairs native Git renames in link destinations and claims without rewriting prose or code",
  { timeout: 60_000 },
  async () => {
    const source = `---
name: Guide
claim_template: &claim
  to: old.md
  predicate: uses
claims:
  - to: old.md
    predicate: uses
  # owner context
  - *claim # owner note
custom: old.md
---
# Guide
Prose old.md stays.
[Billing](old.md#ledger "old.md")
[Slash](/old.md)
[Relative](knowledge/../old.md)
[Reference][billing]

[billing]: old.md 'old.md'
[External](https://example.com/old.md)
\`[Code](old.md)\`
\`\`\`md
[Fenced](old.md)
\`\`\`
`
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "knowledge/old.md",
            body: "---\nname: Billing\n---\n# Billing\nThe ledger stores settled transactions.\n",
          },
          { path: "knowledge/guide.md", body: source },
          {
            path: "README.md",
            body: "# Workspace\n[Billing](knowledge/old.md)\n",
          },
          {
            path: "notion/page.md",
            body: "# Provider page\n[Billing](../knowledge/old.md)\n",
          },
        ],
      },
      async (f) => {
        f.git("reset", "--hard", f.sha)
        mkdirSync(join(f.directory, "knowledge/services"), { recursive: true })
        f.git("mv", "knowledge/old.md", "knowledge/services/billing.md")
        f.git("commit", "-m", "Move billing document")
        f.git("push", f.remote, "HEAD:main")
        const moved = f.git("rev-parse", "HEAD")
        await withOrgIdContext(f.org, () =>
          resolveWorkspaceReadRevision({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            refresh: true,
          }),
        )
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        let worker: ReturnType<typeof runner.newWorker> | undefined
        const jobId = `wjob_${f.id}_rename`
        try {
          const command = {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            kind: "rename_rewrite" as const,
            previousSha: f.sha,
          }
          expect(
            await withOrgIdContext(f.org, () =>
              enqueueWriteJob(command, {
                error: (error) => {
                  throw error
                },
              }),
            ),
          ).toEqual({ started: true })
          const queued = (
            await backend.listWorkflowRuns({ limit: 100 })
          ).data.find(
            (run) => (run.input as { jobId?: string })?.jobId === jobId,
          )
          expect(queued).toMatchObject({
            workflowName: "workspace-write-rename-rewrite",
            input: { previousSha: f.sha, revision: { sha: moved } },
          })
          const { workspaceRenameRewrite, workspaceRenameRewriteInputSchema } =
            await import(
              "../../openworkflow/workflows/workspace-rename-rewrite.js"
            )
          runner.implementWorkflow(
            workspaceRenameRewrite.spec,
            workspaceRenameRewrite.fn,
          )
          worker = runner.newWorker({ concurrency: 1 })
          await worker.start()
          await expect
            .poll(
              () =>
                withOrgIdContext(f.org, () =>
                  reconcileWorkspaceWriteJob(jobId),
                ),
              { timeout: 25_000 },
            )
            .toMatchObject({ status: "completed" })
          const result = f.git(
            "--git-dir",
            f.remote,
            "show",
            "main:knowledge/guide.md",
          )
          expect(
            f.git("--git-dir", f.remote, "show", "main:README.md"),
          ).toContain("[Billing](knowledge/services/billing.md)")
          expect(
            f.git("--git-dir", f.remote, "show", "main:notion/page.md"),
          ).toContain("[Billing](../knowledge/services/billing.md)")
          expect(result).toContain("[Slash](services/billing.md)")
          expect(result).toContain("[Relative](services/billing.md)")
          expect(result).toContain("to: services/billing.md")
          expect(result).toContain(
            '[Billing](services/billing.md#ledger "old.md")',
          )
          expect(result).toContain("[billing]: services/billing.md 'old.md'")
          expect(result).toContain("custom: old.md")
          expect(result).toContain("# owner context")
          expect(result).toContain("# owner note")
          const { parse } = await import("yaml")
          const metadata = parse(result.split("---")[1] ?? "")
          expect(metadata.claim_template.to).toBe("old.md")
          expect(metadata.claims[1].to).toBe("services/billing.md")
          expect(result).toContain("Prose old.md stays.")
          expect(result).toContain("`[Code](old.md)`")
          expect(result).toContain("```md\n[Fenced](old.md)\n```")
          expect(result).toContain("[External](https://example.com/old.md)")
          const replay = await runner.runWorkflow(
            workspaceRenameRewrite.spec,
            workspaceRenameRewriteInputSchema.parse(queued?.input),
          )
          expect(await replay.result({ timeoutMs: 15_000 })).toMatchObject({
            committed: true,
          })
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${moved}..main`,
            ),
          ).toBe("1")
        } finally {
          await worker?.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "rebases links inside moved documents and skips ambiguous, malformed and binary rename targets",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "knowledge/old-a.md",
            body: "# Duplicate\nIdentical source content for ambiguous matching.\n",
          },
          {
            path: "knowledge/old-b.md",
            body: "# Duplicate\nIdentical source content for ambiguous matching.\n",
          },
          {
            path: "knowledge/stable.md",
            body: "# Stable\nUnchanged destination.\n",
          },
          {
            path: "knowledge/guide.md",
            body: "# Guide\n[Stable](stable.md)\n[Ambiguous](old-a.md)\n[Malformed](broken.md)\n[Binary](blob.md)\n",
          },
          {
            path: "knowledge/broken.md",
            body: "---\nname: [\n---\nMalformed metadata.\n",
          },
          { path: "knowledge/blob.md", body: "Binary\0data" },
        ],
      },
      async (f) => {
        f.git("reset", "--hard", f.sha)
        mkdirSync(join(f.directory, "knowledge/nested"), { recursive: true })
        f.git("mv", "knowledge/old-a.md", "knowledge/merged.md")
        f.git("rm", "knowledge/old-b.md")
        f.git("mv", "knowledge/guide.md", "knowledge/nested/guide.md")
        f.git("mv", "knowledge/broken.md", "knowledge/repaired.md")
        f.git("mv", "knowledge/blob.md", "knowledge/data.md")
        writeFileSync(
          join(f.directory, "knowledge/invalid-utf8.md"),
          Buffer.from([0xff, 0xfe, 0x41]),
        )
        f.git("add", "knowledge/invalid-utf8.md")
        f.git(
          "commit",
          "-m",
          "Move documents with ambiguous and non-text sources",
        )
        f.git("push", f.remote, "HEAD:main")
        const moved = f.git("rev-parse", "HEAD")
        const resolved = await withOrgIdContext(f.org, () =>
          resolveWorkspaceReadRevision({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            refresh: true,
          }),
        )
        if (!resolved) throw new Error("Revision unavailable")
        const { workspaceRenameRewrite } = await import(
          "../../openworkflow/workflows/workspace-rename-rewrite.js"
        )
        f.runner.implementWorkflow(
          workspaceRenameRewrite.spec,
          workspaceRenameRewrite.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          const handle = await f.runner.runWorkflow(
            workspaceRenameRewrite.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_rename_safety`,
              previousSha: f.sha,
              revision: { ...resolved.revision, access: "write-default" },
            },
          )
          await worker.start()
          expect(await handle.result({ timeoutMs: 25_000 })).toMatchObject({
            committed: true,
          })
          const guide = f.git(
            "--git-dir",
            f.remote,
            "show",
            "main:knowledge/nested/guide.md",
          )
          expect(guide).toBe(
            "# Guide\n[Stable](../stable.md)\n[Ambiguous](old-a.md)\n[Malformed](broken.md)\n[Binary](blob.md)",
          )
          expect(
            f.git("--git-dir", f.remote, "diff", "--name-only", moved, "main"),
          ).toBe("knowledge/nested/guide.md")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it(
  "converges when repairing a moved source document more than once",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "knowledge/deep/guide.md",
            body: "# Guide\nStable source instructions remain unchanged.\nFollow the document linked below for the canonical definition.\nThe purpose of this paragraph is to describe the operational guide.\n[Stable](stable.md)\n[Stable](stable.md)\n",
          },
          {
            path: "knowledge/deep/stable.md",
            body: "# Stable\nThe intended target.\n",
          },
          {
            path: "knowledge/deep/deep/stable.md",
            body: "# Decoy\nA different document.\n",
          },
        ],
      },
      async (f) => {
        f.git("reset", "--hard", f.sha)
        f.git("mv", "knowledge/deep/guide.md", "knowledge/guide.md")
        const { readFileSync } = await import("node:fs")
        const guidePath = join(f.directory, "knowledge/guide.md")
        writeFileSync(
          guidePath,
          readFileSync(guidePath, "utf8").replaceAll(
            "[Stable]",
            "[Stable definition]",
          ),
        )
        f.git("add", "knowledge/guide.md")
        f.git("commit", "-m", "Move guide up a directory")
        f.git("push", f.remote, "HEAD:main")
        await withOrgIdContext(f.org, () =>
          resolveWorkspaceReadRevision({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            refresh: true,
          }),
        )
        const { workspaceRenameRewrite } = await import(
          "../../openworkflow/workflows/workspace-rename-rewrite.js"
        )
        f.runner.implementWorkflow(
          workspaceRenameRewrite.spec,
          workspaceRenameRewrite.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const first = await f.runner.runWorkflow(
            workspaceRenameRewrite.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_first`,
              previousSha: f.sha,
              revision: {
                ...(await f.resolveRevision()),
                access: "write-default",
              },
            },
          )
          expect(await first.result({ timeoutMs: 20_000 })).toMatchObject({
            committed: true,
          })
          expect(
            f.git("--git-dir", f.remote, "show", "main:knowledge/guide.md"),
          ).toContain(
            "[Stable definition](deep/stable.md)\n[Stable definition](deep/stable.md)",
          )
          const second = await f.runner.runWorkflow(
            workspaceRenameRewrite.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_second`,
              previousSha: f.sha,
              revision: {
                ...(await f.resolveRevision()),
                access: "write-default",
              },
            },
          )
          expect(await second.result({ timeoutMs: 20_000 })).toEqual({
            committed: false,
            reason: "no_changes",
          })
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
