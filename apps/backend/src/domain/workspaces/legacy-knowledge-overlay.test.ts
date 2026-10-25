import { describe, expect, it } from "vitest"

import { hydrateKnowledgeTree } from "./hydrate.js"
import { parseSimpleFrontMatter } from "./layout.js"
import {
  legacyKnowledgeOverlay,
  legacyKnowledgeOverlayScope,
  markLegacyOverlaySkips,
} from "./legacy-knowledge-overlay.js"
import type { ExportObjectRow } from "./migration-export.js"

const source = {
  firstWorkspaceId: "ws_first",
  workspaceByRepositoryId: new Map([["repo_other", "ws_other"]]),
  repositoryGitUrlById: new Map([
    ["repo_tools", "https://gitlab.com/example/tools.git"],
    ["repo_other", "https://github.com/example/other.git"],
  ]),
  objects: [
    {
      id: "obj_parser",
      kind: "Library",
      deduplicationKey: "lib:repo_tools:parser",
      payload: { name: "Parser", summary: "Reads the manifest." },
    },
    {
      id: "obj_tools",
      kind: "Service",
      deduplicationKey: "svc:repo_tools:tools",
      payload: { name: "Tools CLI", summary: "The release tools." },
    },
    {
      id: "obj_guide",
      kind: "Document",
      deduplicationKey: "doc:repo_tools:guide",
      payload: { name: "Guide", path: "./docs/guide.md" },
    },
    {
      id: "obj_other",
      kind: "Service",
      deduplicationKey: "svc:repo_other:other",
      payload: { name: "Other service" },
    },
  ],
  claims: [
    {
      subjectId: "obj_tools",
      objectId: "obj_parser",
      predicate: "USES",
      aggregatedConfidence: 0.9,
      validFrom: "2026-01-01T00:00:00Z",
      validTo: null,
    },
    {
      subjectId: "obj_tools",
      objectId: "obj_guide",
      predicate: "DOCUMENTED_BY",
      aggregatedConfidence: 0.8,
      validFrom: "2026-01-01T00:00:00Z",
      validTo: null,
    },
  ],
}

function overlay(
  files: Array<{ path: string; content: string }>,
  objects: readonly ExportObjectRow[] = source.objects,
  options: {
    deletedPaths?: ReadonlySet<string>
    onlyRepositoryUrls?: ReadonlySet<string>
  } = {},
) {
  return legacyKnowledgeOverlay({
    workspaceId: "ws_first",
    workspaceRepositoryUrl: "https://github.com/example/context",
    treePaths: new Set(files.map((file) => file.path)),
    files,
    deletedPaths: options.deletedPaths ?? new Set(),
    onlyRepositoryUrls: options.onlyRepositoryUrls,
    reingestedRepositories: new Set(),
    source: { ...source, objects },
  })
}

describe("legacyKnowledgeOverlay", () => {
  it("gives all knowledge below format 3, and only source repositories up to the code format", () => {
    expect([-1, 0, 1, 2, 3, 4].map(legacyKnowledgeOverlayScope)).toEqual([
      null,
      "all",
      "all",
      "all",
      "sources",
      null,
    ])
  })

  it("does not bring back a file that a commit deleted", async () => {
    const first = await overlay([])
    const parser = first.find((file) => file.path.endsWith("parser.md"))
    if (!parser) throw new Error("Expected a parser file")
    const after = await overlay([], source.objects, {
      deletedPaths: new Set([parser.path]),
    })
    expect(after.map((file) => file.path)).toEqual(
      first.map((file) => file.path).filter((path) => path !== parser.path),
    )
  })

  it("gives only the objects of the named repositories", async () => {
    const files = await overlay([], source.objects, {
      onlyRepositoryUrls: new Set(["https://github.com/example/missing"]),
    })
    expect(files).toEqual([])
    const tools = await overlay([], source.objects, {
      onlyRepositoryUrls: new Set(["https://gitlab.com/example/tools"]),
    })
    // Each object of the fixture is of that repository, except the one of
    // another Workspace.
    expect(tools).toEqual(await overlay([]))
  })

  it("gives the objects of the Workspace as files, with their links, and not those of another Workspace", async () => {
    const files = await overlay([
      { path: "docs/guide.md", content: "# Guide\n" },
    ])
    expect(files.map((file) => file.path).sort()).toEqual([
      expect.stringMatching(/^knowledge\/.+\/parser\.md$/),
      expect.stringMatching(/^knowledge\/.+\/tools-cli\.md$/),
    ])
    const tools = files.find((file) => file.path.endsWith("tools-cli.md"))
    expect(tools?.content).toContain("The release tools.")
    expect(tools?.content).toContain("predicate: USES")
    // The object of a Markdown file in git gets no file; the link goes to git.
    expect(tools?.content).toContain("predicate: DOCUMENTED_BY")
    expect(tools?.content).toMatch(/to: (\.\.\/)+docs\/guide\.md/)
  })

  it("keeps a file of git and gives the same files for rows in another order", async () => {
    const first = await overlay([])
    const taken = first.find((file) => file.path.endsWith("parser.md"))
    if (!taken) throw new Error("Expected a parser file")
    const withGit = await overlay([
      { path: taken.path, content: taken.content },
    ])
    expect(withGit.map((file) => file.path)).not.toContain(taken.path)
    expect(await overlay([], [...source.objects].reverse())).toEqual(first)
  })

  it("writes front matter that hydrate reads, also for an untitled object whose key ends with a colon", async () => {
    const files = await overlay(
      [],
      [
        {
          id: "obj_untitled",
          kind: "API",
          deduplicationKey: "api:repo_tools:v1:",
          payload: { summary: "Has no title." },
        },
      ],
    )
    expect(files).toHaveLength(1)
    const [file] = files
    const parsed = parseSimpleFrontMatter(file?.content ?? "")
    expect(parsed.malformed).toBe(false)
    expect(parsed.attributes.import_key).toBe("api:repo_tools:v1:")
  })

  it("marks a skipped overlay file, and no skipped file of git", () => {
    const overlayFile = {
      path: "knowledge/apis/imported.md",
      content: "---\nimport_key: [broken\n---\n\nBody\n",
    }
    const gitFile = {
      path: "knowledge/billing/tax.md",
      content: "---\nkind: [broken\n---\n\nBody\n",
    }
    const { skipped } = hydrateKnowledgeTree({
      workspaceId: "ws_first",
      files: [overlayFile, gitFile],
    })
    expect(skipped.map((skip) => skip.path).sort()).toEqual([
      overlayFile.path,
      gitFile.path,
    ])
    expect(
      markLegacyOverlaySkips(skipped, new Set([overlayFile.path])).sort(
        (a, b) => a.path.localeCompare(b.path),
      ),
    ).toEqual([
      { path: overlayFile.path, reason: "malformed", source: "legacy-overlay" },
      { path: gitFile.path, reason: "malformed" },
    ])
  })
})
