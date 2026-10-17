import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { ownershipMigrationFiles } from "./ownership-migration.js"
import { fileOwnership } from "./patch-validator.js"

const workspaceRepositoryUrl = "https://github.com/acme/context"
// The source file of each repository in the Workspace (ADR-050 revision
// 2026-10-16), by normalized repository URL.
const sourcePaths = new Map(
  ["api", "billing", "web", "worker"].map((name) => [
    `https://github.com/acme/${name}`,
    `sources/github/acme/${name}.md`,
  ]),
)

function front(content: string): Record<string, unknown> {
  return parse(content.split("---")[1] ?? "") as Record<string, unknown>
}

describe("ownership migration of old extracted files", () => {
  it("moves an old extracted file to ingestion v2 ownership and keeps the body", () => {
    const body =
      "\n# Billing\n\nText.\n\n<!-- ctxpipe:human -->\nA human note.\n<!-- /ctxpipe:human -->\n"
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths,
      files: [
        {
          path: "knowledge/services/billing.md",
          content: `---\nimport_key: repo_1:service:billing\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/Acme/Billing.git#src/index.ts\n---\n${body}`,
        },
      ],
    })
    expect(migrated?.path).toBe("knowledge/services/billing.md")
    expect(front(migrated?.content ?? "")).toEqual({
      kind: "Service",
      name: "Billing",
      generated_by: "ctxpipe-extract",
      sources: ["sources/github/acme/billing.md"],
    })
    expect(migrated?.content.endsWith(`---\n${body}`)).toBe(true)
    expect(
      fileOwnership(migrated?.content ?? "", "sources/github/acme/billing.md"),
    ).toBe("sole")
  })

  it("converts the old front matter to the shape that the ingestion v2 validator accepts", () => {
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths,
      files: [
        {
          path: "knowledge/services/orders.md",
          content: [
            "---",
            "kind: Service",
            'name: "  Orders  "',
            "summary: Takes orders.",
            "confidence: 0.8",
            "aliases: [orders-api]",
            "generated_by: ctxpipe",
            "source: https://github.com/acme/api#src/orders.ts",
            "claims:",
            "  - to: ./billing.md",
            "    predicate: CALLS",
            "    confidence: 0.9",
            "    valid_from: 2026-01-01T00:00:00.000Z",
            "    source: https://github.com/acme/api.git#src/billing-client.ts",
            "  - to: ./ledger.md",
            "    predicate: WRITES",
            "  - to: ./old.md",
            "    predicate: CALLS",
            "    valid_to: 2026-02-01T00:00:00.000Z",
            "  - to: ./unnamed.md",
            "  - to: ./outside.md",
            "    predicate: READS",
            "    source: ../../outside.ts",
            "---",
            "",
            "# Orders API",
            "",
          ].join("\n"),
        },
      ],
    })
    expect(front(migrated?.content ?? "")).toEqual({
      kind: "Service",
      name: "Orders",
      summary: "Takes orders.",
      generated_by: "ctxpipe-extract",
      sources: ["sources/github/acme/api.md"],
      claims: [
        {
          to: "./billing.md",
          predicate: "CALLS",
          confidence: 0.9,
          valid_from: "2026-01-01T00:00:00.000Z",
          source: "https://github.com/acme/api.git#src/billing-client.ts",
          evidence: { kind: "legacy" },
        },
        {
          to: "./ledger.md",
          predicate: "WRITES",
          confidence: 0.8,
          evidence: { kind: "legacy" },
        },
        {
          to: "./old.md",
          predicate: "CALLS",
          confidence: 0.8,
          valid_to: "2026-02-01T00:00:00.000Z",
          evidence: { kind: "legacy" },
        },
        { to: "./unnamed.md", confidence: 0.8, evidence: { kind: "legacy" } },
        {
          to: "./outside.md",
          predicate: "READS",
          confidence: 0.8,
          source: "../../outside.ts",
          evidence: { kind: "legacy" },
        },
      ],
    })
  })

  it("reports each old claim that it cannot keep, and why", () => {
    const dropped: unknown[] = []
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths,
      files: [
        {
          path: "knowledge/services/odd.md",
          content: [
            "---",
            "generated_by: ctxpipe",
            "source: https://github.com/acme/api#a.ts",
            "claims:",
            "  - just text",
            "  - predicate: CALLS",
            "  - to: ./kept.md",
            '  - to: "  "',
            "---",
            "",
            "# Odd",
            "",
          ].join("\n"),
        },
      ],
      onDroppedClaim: (drop) => dropped.push(drop),
    })
    expect(front(migrated?.content ?? "").claims).toEqual([
      { to: "./kept.md", evidence: { kind: "legacy" } },
    ])
    expect(dropped).toEqual([
      {
        path: "knowledge/services/odd.md",
        index: 0,
        reason: "The claim is not a map",
      },
      {
        path: "knowledge/services/odd.md",
        index: 1,
        reason: "The claim has no target (to)",
      },
      {
        path: "knowledge/services/odd.md",
        index: 3,
        reason: "The claim has no target (to)",
      },
    ])
  })

  it("names a file from its first heading, or else from its path", () => {
    const migrated = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths,
      files: [
        {
          path: "knowledge/services/headed.md",
          content:
            "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/api#a.ts\n---\n\nIntro.\n\n# Headed Service\n",
        },
        {
          path: "knowledge/libraries/no-name.md",
          content:
            "---\nkind: Library\ngenerated_by: ctxpipe\nsource: https://github.com/acme/api#package.json\n---\n\nNo heading.\n",
        },
      ],
    })
    expect(migrated.map((file) => front(file.content).name)).toEqual([
      "Headed Service",
      "no-name",
    ])
  })

  it("moves a file that the import-key cleanup already changed", () => {
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths,
      files: [
        {
          path: "knowledge/libraries/zod.md",
          content:
            "---\nkind: Library\ngenerated_by: ctxpipe\nsource: git@github.com:acme/web.git#package.json\n---\n\n# Zod\n",
        },
      ],
    })
    expect(front(migrated?.content ?? "").sources).toEqual([
      "sources/github/acme/web.md",
    ])
  })

  it("adds the source path to the source paths that a file already lists, and drops a URL", () => {
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths,
      files: [
        {
          path: "knowledge/databases/orders.md",
          content:
            "---\nkind: Database\ngenerated_by: ctxpipe\nsource: https://github.com/acme/api#db.sql\nsources:\n  - sources/github/acme/worker.md\n  - https://github.com/acme/worker\n---\n\n# Orders\n",
        },
      ],
    })
    expect(front(migrated?.content ?? "").sources).toEqual([
      "sources/github/acme/worker.md",
      "sources/github/acme/api.md",
    ])
  })

  it("does not change a file whose repository has no source file in the Workspace", () => {
    expect(
      ownershipMigrationFiles({
        workspaceRepositoryUrl,
        sourcePaths,
        files: [
          {
            path: "knowledge/services/gone.md",
            content:
              "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/unlinked#a.ts\n---\n\n# Gone\n",
          },
        ],
      }),
    ).toEqual([])
  })

  it("does not change a file that a human, a connector, or ingestion v2 owns", () => {
    expect(
      ownershipMigrationFiles({
        workspaceRepositoryUrl,
        sourcePaths,
        files: [
          {
            path: "knowledge/services/taken-over.md",
            content:
              "---\nkind: Service\nsource: https://github.com/acme/api#a.ts\n---\n\n# Taken over\n",
          },
          {
            path: "knowledge/services/v2.md",
            content:
              "---\nkind: Service\ngenerated_by: ctxpipe-extract\nsources:\n  - https://github.com/acme/api\n---\n\n# V2\n",
          },
          {
            path: "knowledge/notes.md",
            content: "# No front matter\n",
          },
          {
            path: "knowledge/broken.md",
            content: "---\ngenerated_by: ctxpipe\nsource: [\n---\n\n# Broken\n",
          },
          {
            path: "notion/page.md",
            content:
              "---\ngenerated_by: ctxpipe\nsource: https://github.com/acme/api#a.ts\n---\n\n# Mirror\n",
          },
          {
            path: "knowledge/readme.txt",
            content:
              "---\ngenerated_by: ctxpipe\nsource: https://github.com/acme/api#a.ts\n---\n",
          },
        ],
      }),
    ).toEqual([])
  })

  it("does not change an old file with no source repository", () => {
    expect(
      ownershipMigrationFiles({
        workspaceRepositoryUrl,
        sourcePaths,
        files: [
          {
            path: "knowledge/services/no-source.md",
            content:
              "---\nimport_key: repo_1:service:x\ngenerated_by: ctxpipe\n---\n\n# X\n",
          },
          {
            path: "knowledge/services/relative.md",
            content:
              "---\ngenerated_by: ctxpipe\nsource: ../../docs/x.md\n---\n\n# X\n",
          },
          {
            path: "knowledge/services/context.md",
            content:
              "---\ngenerated_by: ctxpipe\nsource: https://github.com/acme/context.git#docs/x.md\n---\n\n# X\n",
          },
        ],
      }),
    ).toEqual([])
  })

  it("makes no change on a second pass", () => {
    const once = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths,
      files: [
        {
          path: "knowledge/services/billing.md",
          content:
            "---\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing#a.ts\n---\n\n# Billing\n",
        },
      ],
    })
    expect(once).toHaveLength(1)
    expect(
      ownershipMigrationFiles({
        workspaceRepositoryUrl,
        sourcePaths,
        files: once,
      }),
    ).toEqual([])
  })
})
