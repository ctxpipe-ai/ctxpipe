import { expect, it } from "vitest"
import { workspaceExtractIngest } from "../../openworkflow/workflows/workspace-extract-ingest.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { parseSimpleFrontMatter } from "./layout.js"

it.each([
  { path: "knowledge/services/billing.md", mode: "full" as const },
  { path: "handbook/services/billing.md", mode: "partial" as const },
  { path: "knowledge/services/billing.md", mode: "directory" as const },
])(
  "expires unsupported $mode source claims at $path while retaining owner prose and unrelated evidence",
  { timeout: 40_000 },
  async ({ path, mode }) => {
    const body = `---
custom: Owner metadata
claims:
  - to: ../targets/ledger.md
    predicate: CALLS
    source: https://github.com/fixture/hydration-contract.git#${mode === "directory" ? "src" : "src/billing.ts"}
    confidence: 0.7
    valid_from: '2026-08-01T00:00:00.000Z'
    note: Owner annotation
  - to: ../targets/ledger.md
    predicate: USES
    source: https://github.com/other/repository.git#src/client.ts
  - to: ../targets/ledger.md
    predicate: RETAINS
    source: https://github.com/fixture/hydration-contract.git#src/unchanged.ts
  - to: ../targets/ledger.md
    predicate: DOCUMENTS
---

# Billing
Owner prose must survive unchanged.
`
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path, body },
          { path: "knowledge/targets/ledger.md", body: "# Ledger\n" },
          { path: "slack/capture.md", body },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        f.runner.implementWorkflow(
          workspaceExtractIngest.spec,
          workspaceExtractIngest.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        const extraction = {
          repositoryId: "repo_fixture",
          repositoryUrl: f.workspaceUrl,
          sourceSha: f.sha,
          objects: [],
          claims: [],
          retraction:
            mode === "full"
              ? { mode, observedAt: "2026-09-01T00:00:00.000Z" }
              : {
                  mode: "partial" as const,
                  paths: ["src/billing.ts"],
                  observedAt: "2026-09-01T00:00:00.000Z",
                },
        }
        try {
          await worker.start()
          const handle = await f.runner.runWorkflow(
            workspaceExtractIngest.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_retract`,
              revision: { ...f.revision, access: "write-default" },
              extraction,
            },
          )
          expect(await handle.result({ timeoutMs: 20_000 })).toMatchObject({
            committed: true,
          })
          const content = f.git("--git-dir", f.remote, "show", `main:${path}`)
          expect(parseSimpleFrontMatter(content).attributes).toEqual({
            custom: "Owner metadata",
            claims: [
              {
                to: "../targets/ledger.md",
                predicate: "CALLS",
                source:
                  mode === "directory"
                    ? "https://github.com/fixture/hydration-contract.git#src"
                    : "https://github.com/fixture/hydration-contract.git#src/billing.ts",
                confidence: 0.7,
                valid_from: "2026-08-01T00:00:00.000Z",
                valid_to: "2026-09-01T00:00:00.000Z",
                note: "Owner annotation",
              },
              {
                to: "../targets/ledger.md",
                predicate: "USES",
                source: "https://github.com/other/repository.git#src/client.ts",
              },
              {
                to: "../targets/ledger.md",
                predicate: "RETAINS",
                source:
                  "https://github.com/fixture/hydration-contract.git#src/unchanged.ts",
                ...(mode === "full"
                  ? { valid_to: "2026-09-01T00:00:00.000Z" }
                  : {}),
              },
              { to: "../targets/ledger.md", predicate: "DOCUMENTS" },
            ],
          })
          expect(content).toContain(
            "# Billing\nOwner prose must survive unchanged.",
          )
          expect(
            f.git("--git-dir", f.remote, "diff", "--name-only", f.sha, "main"),
          ).toBe(path)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("1")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)

it.each([
  {
    mode: "canonical",
    sourcePath: "src/billing.ts",
    source: "https://github.com/fixture/hydration-contract.git#src/billing.ts",
  },
  {
    mode: "encoded",
    sourcePath: "src/a#b.ts",
    source: "https://github.com/fixture/hydration-contract.git#src/a%23b.ts",
  },
  {
    mode: "legacy unescaped fragment",
    sourcePath: "src/a#b.ts",
    existingSource:
      "https://github.com/fixture/hydration-contract.git#src/a#b.ts",
    source: "https://github.com/fixture/hydration-contract.git#src/a%23b.ts",
  },
  {
    mode: "relative evidence",
    sourcePath: "src/billing.ts",
    existingSource: "../../src/billing.ts",
    source: "https://github.com/fixture/hydration-contract.git#src/billing.ts",
  },
  {
    mode: "normalized URL evidence",
    sourcePath: "src/billing.ts",
    existingSource:
      "https://github.com/fixture/hydration-contract#src/billing.ts",
    source: "https://github.com/fixture/hydration-contract.git#src/billing.ts",
  },
])(
  "reasserts an expired captured claim from $sourcePath ($mode) and preserves source history",
  { timeout: 40_000 },
  async ({ sourcePath, source, existingSource }) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          {
            path: "knowledge/services/billing.md",
            body: `---
import_key: legacy:billing
claims:
  - to: ../targets/ledger.md
    predicate: CALLS
    source: https://github.com/fixture/hydration-contract.git#src/retired.ts
    valid_from: '2026-08-01T00:00:00.000Z'
    note: Retired source annotation
  - to: ../targets/ledger.md
    predicate: CALLS
    source: ${existingSource ?? source}
    valid_from: '2026-08-01T00:00:00.000Z'
    valid_to: '2026-09-01T00:00:00.000Z'
    note: Owner annotation
  - to: ../targets/ledger.md
    predicate: CALLS
    source: https://github.com/other/repository.git#src/ledger.ts
    note: Other repository annotation
---

# Billing
Owner notes.
`,
          },
          {
            path: "knowledge/targets/ledger.md",
            body: "---\nimport_key: legacy:ledger\n---\n# Ledger\n",
          },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        f.runner.implementWorkflow(
          workspaceExtractIngest.spec,
          workspaceExtractIngest.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        const extraction = {
          repositoryId: "repo_fixture",
          repositoryUrl: f.workspaceUrl,
          sourceSha: f.sha,
          objects: [
            {
              kind: "Service",
              deduplicationKey: "legacy:billing",
              payload: { name: "Billing" },
            },
            {
              kind: "Service",
              deduplicationKey: "legacy:ledger",
              payload: { name: "Ledger" },
            },
          ],
          claims: [
            {
              subjectRef: "legacy:billing",
              objectRef: "legacy:ledger",
              predicate: "CALLS",
              sourceId: "captured-billing-call",
              sourcePath,
              confidence: 0.7,
            },
          ],
          retraction: {
            mode: "full" as const,
            observedAt: "2026-09-02T00:00:00.000Z",
          },
        }
        try {
          await worker.start()
          const handle = await f.runner.runWorkflow(
            workspaceExtractIngest.spec,
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_reassert`,
              revision: { ...f.revision, access: "write-default" },
              extraction,
            },
          )
          expect(await handle.result({ timeoutMs: 20_000 })).toMatchObject({
            committed: true,
          })
          const content = f.git(
            "--git-dir",
            f.remote,
            "show",
            "main:knowledge/services/billing.md",
          )
          expect(parseSimpleFrontMatter(content).attributes.claims).toEqual([
            {
              to: "../targets/ledger.md",
              predicate: "CALLS",
              source:
                "https://github.com/fixture/hydration-contract.git#src/retired.ts",
              valid_from: "2026-08-01T00:00:00.000Z",
              valid_to: "2026-09-02T00:00:00.000Z",
              note: "Retired source annotation",
            },
            {
              to: "../targets/ledger.md",
              predicate: "CALLS",
              source,
              valid_from: "2026-09-02T00:00:00.000Z",
              confidence: 0.7,
              note: "Owner annotation",
            },
            {
              to: "../targets/ledger.md",
              predicate: "CALLS",
              source: "https://github.com/other/repository.git#src/ledger.ts",
              note: "Other repository annotation",
            },
          ])
          expect(content).toContain("Owner notes.")
        } finally {
          await worker.stop()
        }
      },
    )
  },
)
