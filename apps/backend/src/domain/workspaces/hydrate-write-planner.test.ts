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

function plan(
  files: Array<{ path: string; content: string }>,
  sourcesFile: string | null,
) {
  const bootstrapped = bootstrapWorkspaceFiles({
    displayName: "Knowledge",
    existing: new Map(),
  })
  return planHydrateWrites({
    revision,
    displayName: "Knowledge",
    files: [...bootstrapped, ...files],
    sourcesFile,
    publishPipeline: "legacy",
  }).filter((requirement) => requirement.kind === "link_unlink")
}

describe("planHydrateWrites: repository files of ADR-050", () => {
  it("plans one link edit that moves the GitHub repository files", () => {
    expect(
      plan(
        [
          {
            path: "repositories/web.md",
            content: declaration("https://github.com/Acme/Web.git", "stable"),
          },
          {
            path: "repositories/api.md",
            content: declaration("https://github.com/acme/api"),
          },
        ],
        null,
      ),
    ).toEqual([
      {
        kind: "link_unlink",
        remainder: 2,
        linkGitUrl: "https://github.com/acme/web",
      },
    ])
  })

  it("plans nothing when no file can move", () => {
    const sources =
      "version: 1\nsources:\n  - id: code\n    provider: github\n    connection: con_gh\n    repositories: [{name: acme/web, ref: main}]\n"
    expect(
      plan(
        [
          // Linked with another ref: the file stays, as a source error.
          {
            path: "repositories/web.md",
            content: declaration("https://github.com/acme/web", "stable"),
          },
          {
            path: "repositories/tools.md",
            content: declaration("https://gitlab.com/acme/tools"),
          },
        ],
        sources,
      ),
    ).toEqual([])
    // An invalid sources file takes no link edit.
    expect(
      plan(
        [
          {
            path: "repositories/api.md",
            content: declaration("https://github.com/acme/api"),
          },
        ],
        "version: 2\n",
      ),
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

function ownershipRemainder(publishPipeline: "legacy" | "v2") {
  return planHydrateWrites({
    revision: migrationRevision,
    displayName: "Context",
    files: migrationFiles,
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
})
