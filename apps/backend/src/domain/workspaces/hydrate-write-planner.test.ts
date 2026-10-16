import { describe, expect, it } from "vitest"
import { bootstrapWorkspaceFiles } from "./bootstrap.js"
import { planHydrateWrites } from "./hydrate-write-planner.js"
import type { WorkspaceRevision } from "./revision.js"

const revision: WorkspaceRevision = {
  workspaceId: "ws_planner",
  generation: 1,
  remote: {
    url: "https://github.com/acme/knowledge",
    connectionId: "con_gh",
  },
  defaultBranch: "main",
  sha: "a".repeat(40),
  access: "read",
}

const declaration = (git: string, branch?: string) =>
  `---\ngit: ${git}\n${branch ? `branch: ${branch}\n` : ""}---\n`

function plan(files: Array<{ path: string; content: string }>) {
  const bootstrapped = bootstrapWorkspaceFiles({
    displayName: "Knowledge",
    existing: new Map(),
  })
  return planHydrateWrites({
    revision,
    displayName: "Knowledge",
    files: [...bootstrapped, ...files],
    sourceFiles: [],
    publishPipeline: "legacy",
  })
}

describe("planHydrateWrites: repository files of ADR-050", () => {
  it("plans no write for repository files (the conversion moves them)", () => {
    expect(
      plan([
        {
          path: "repositories/web.md",
          content: declaration("https://github.com/Acme/Web.git", "stable"),
        },
        {
          path: "repositories/api.md",
          content: declaration("https://github.com/acme/api"),
        },
      ]),
    ).toEqual([])
  })
})

const migrationRevision = {
  workspaceId: "ws_planner",
  generation: 1,
  remote: { url: "https://github.com/acme/context", connectionId: "con_1" },
  defaultBranch: "main",
  sha: "a".repeat(40),
  access: "read" as const,
}

const migrationBootstrapped = bootstrapWorkspaceFiles({
  displayName: "Context",
  existing: new Map(),
})

const migrationFiles = [
  ...migrationBootstrapped,
  {
    path: "knowledge/services/billing.md",
    content:
      "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/acme/billing#a.ts\n---\n\n# Billing\n",
  },
  {
    path: "knowledge/services/human.md",
    content:
      "---\nkind: Service\nsource: https://github.com/acme/billing#b.ts\n---\n\n# Human\n",
  },
]

// The GitHub source file that declares the repository of the old files.
const billingSource = {
  path: "sources/github/acme/billing.md",
  text: "---\nprovider: github\nconnection: con_1\nrepository: acme/billing\n---\n",
}

function ownershipRemainder(
  publishPipeline: "legacy" | "v2",
  sourceFiles = [billingSource],
) {
  return planHydrateWrites({
    revision: migrationRevision,
    displayName: "Context",
    files: migrationFiles,
    sourceFiles,
    publishPipeline,
  }).find((write) => write.kind === "ownership_migration")
}

describe("hydrate write plan for the ownership migration", () => {
  it("plans the migration of old extracted files when ingestion v2 publishes", () => {
    expect(ownershipRemainder("v2")).toEqual({
      kind: "ownership_migration",
      remainder: 1,
    })
  })

  it("plans no migration while the old pipeline publishes", () => {
    expect(ownershipRemainder("legacy")).toBeUndefined()
  })

  it("plans no migration when no source file names the repository", () => {
    expect(ownershipRemainder("v2", [])).toBeUndefined()
  })
})
