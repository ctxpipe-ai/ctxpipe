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

async function plan(files: Array<{ path: string; content: string }>) {
  const bootstrapped = bootstrapWorkspaceFiles({
    displayName: "Knowledge",
    existing: new Map(),
  })
  return planHydrateWrites({
    revision,
    displayName: "Knowledge",
    files: [...bootstrapped, ...files],
    sourceFiles: [],
    sourceRows: [],
    format: 3,
  })
}

describe("planHydrateWrites: repository files of ADR-050", () => {
  it("plans no write for repository files (the conversion moves them)", async () => {
    expect(
      await plan([
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

async function ownershipRemainder(
  format: number,
  sourceFiles = [billingSource],
) {
  return (
    await planHydrateWrites({
      revision: migrationRevision,
      displayName: "Context",
      files: migrationFiles,
      sourceFiles,
      sourceRows: [],
      format,
    })
  ).find((write) => write.kind === "ownership_migration")
}

describe("hydrate write plan for the ownership migration", () => {
  it("plans the migration of old extracted files on a tree at format 3 or more", async () => {
    expect(await ownershipRemainder(3)).toEqual({
      kind: "ownership_migration",
      remainder: 1,
    })
  })

  it("plans no migration below format 3, where upgrade step 3 moves the files", async () => {
    expect(await ownershipRemainder(2)).toBeUndefined()
    expect(await ownershipRemainder(0)).toBeUndefined()
    // A format file that is not valid.
    expect(await ownershipRemainder(-1)).toBeUndefined()
  })

  it("plans no migration when no source file names the repository", async () => {
    expect(await ownershipRemainder(3, [])).toBeUndefined()
  })
})

// A main-era tree: each direct write of hydrate has work to do in it.
const mainEraFiles = [
  {
    path: "AGENTS.md",
    content:
      "---\nname: Context\n---\n\nOur own text.\n<!-- ctxpipe:folder-map -->\n<!-- /ctxpipe:folder-map -->\n",
  },
  {
    path: "knowledge/guides/deploy.md",
    content:
      "---\nkind: Guide\nimport_key: old\nclaims:\n  - to: ../services/billing.md\n---\n\nSee [api](../services/api.md).\n",
  },
  ...migrationFiles.slice(migrationBootstrapped.length),
]

async function mainEraPlan(format: number) {
  let historyRead = false
  const writes = await planHydrateWrites({
    revision: migrationRevision,
    displayName: "Context",
    files: mainEraFiles,
    sourceFiles: [billingSource],
    sourceRows: [],
    format,
    history: async () => {
      historyRead = true
      return {
        previousSha: "b".repeat(40),
        previousFormat: format,
        renameRewrites: 1,
        folderSetChanged: true,
      }
    },
  })
  return { kinds: writes.map((write) => write.kind).sort(), historyRead }
}

describe("hydrate direct writes and the Workspace format (ADR-053 section 7)", () => {
  it.each([0, 1, 2, -1])(
    "plans no direct write to the default branch at format %i, also when AGENTS.md is not the template",
    async (format) => {
      expect(await mainEraPlan(format)).toEqual({
        kinds: [],
        historyRead: false,
      })
    },
  )

  it("keeps each direct write of ctxpipe-managed files at format 3", async () => {
    expect(await mainEraPlan(3)).toEqual({
      kinds: [
        "bootstrap",
        "claims_upgrade",
        "import_key_cleanup",
        "ops_folder_map",
        "ownership_migration",
        "rename_rewrite",
        "valid_from_persist",
      ],
      historyRead: true,
    })
  })

  it("plans no rename or folder write against a tree below format 3, which only the upgrade pull request changed", async () => {
    const writes = await planHydrateWrites({
      revision: migrationRevision,
      displayName: "Context",
      files: migrationFiles,
      sourceFiles: [],
      sourceRows: [],
      format: 3,
      history: async () => ({
        previousSha: "b".repeat(40),
        previousFormat: 2,
        renameRewrites: 1,
        folderSetChanged: true,
      }),
    })
    expect(writes).toEqual([])
  })
})
