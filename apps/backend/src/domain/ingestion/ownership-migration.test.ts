import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { ownershipMigrationFiles } from "./ownership-migration.js"
import { fileOwnership } from "./patch-validator.js"

const workspaceRepositoryUrl = "https://github.com/acme/context"

function front(content: string): Record<string, unknown> {
  return parse(content.split("---")[1] ?? "") as Record<string, unknown>
}

describe("ownership migration of old extracted files", () => {
  it("moves an old extracted file to ingestion v2 ownership and keeps the body", () => {
    const body =
      "\n# Billing\n\nText.\n\n<!-- ctxpipe:human -->\nA human note.\n<!-- /ctxpipe:human -->\n"
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
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
      generated_by: "ctxpipe-extract",
      source: "https://github.com/Acme/Billing.git#src/index.ts",
      sources: ["https://github.com/acme/billing"],
    })
    expect(migrated?.content.endsWith(`---\n${body}`)).toBe(true)
    expect(
      fileOwnership(migrated?.content ?? "", "https://github.com/acme/billing"),
    ).toBe("sole")
  })

  it("moves a file that the import-key cleanup already changed", () => {
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      files: [
        {
          path: "knowledge/libraries/zod.md",
          content:
            "---\nkind: Library\ngenerated_by: ctxpipe\nsource: git@github.com:acme/web.git#package.json\n---\n\n# Zod\n",
        },
      ],
    })
    expect(front(migrated?.content ?? "").sources).toEqual([
      "https://github.com/acme/web",
    ])
  })

  it("adds the source to the sources that a file already lists", () => {
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      files: [
        {
          path: "knowledge/databases/orders.md",
          content:
            "---\nkind: Database\ngenerated_by: ctxpipe\nsource: https://github.com/acme/api#db.sql\nsources:\n  - https://github.com/acme/worker\n---\n\n# Orders\n",
        },
      ],
    })
    expect(front(migrated?.content ?? "").sources).toEqual([
      "https://github.com/acme/worker",
      "https://github.com/acme/api",
    ])
  })

  it("does not change a file that a human, a connector, or ingestion v2 owns", () => {
    expect(
      ownershipMigrationFiles({
        workspaceRepositoryUrl,
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
      ownershipMigrationFiles({ workspaceRepositoryUrl, files: once }),
    ).toEqual([])
  })
})
