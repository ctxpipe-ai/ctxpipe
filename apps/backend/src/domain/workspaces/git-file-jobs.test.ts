import { describe, expect, it } from "vitest"
import {
  explorerChildPath,
  explorerPathsAt,
  explorerRewritePrefix,
  parseWorkspaceFileJobRequest,
  planWorkspaceFileJob,
} from "./git-file-jobs.js"

const tree = [
  "AGENTS.md",
  "knowledge/billing/ledger.md",
  "knowledge/billing/tax.md",
  "knowledge/auth/login.md",
]

async function blobs(map: Record<string, string>) {
  return async (path: string) => map[path] ?? null
}

describe("explorerChildPath", () => {
  it("joins a name under a directory and rejects traversal", () => {
    expect(explorerChildPath("knowledge", "notes.md")).toBe(
      "knowledge/notes.md",
    )
    expect(explorerChildPath(null, "AGENTS.md")).toBe("AGENTS.md")
    expect(explorerChildPath("knowledge", "../secret")).toBeNull()
    expect(explorerChildPath("knowledge", "nested/file.md")).toBeNull()
  })
})

describe("explorerPathsAt", () => {
  it("returns a file itself or every blob under a directory", () => {
    expect(explorerPathsAt(tree, "AGENTS.md")).toEqual(["AGENTS.md"])
    expect(explorerPathsAt(tree, "knowledge/billing")).toEqual([
      "knowledge/billing/ledger.md",
      "knowledge/billing/tax.md",
    ])
  })
})

describe("explorerRewritePrefix", () => {
  it("rewrites a file or directory prefix", () => {
    expect(explorerRewritePrefix("AGENTS.md", "AGENTS.md", "GUIDE.md")).toBe(
      "GUIDE.md",
    )
    expect(
      explorerRewritePrefix(
        "knowledge/billing/ledger.md",
        "knowledge/billing",
        "knowledge/finance",
      ),
    ).toBe("knowledge/finance/ledger.md")
  })
})

describe("planWorkspaceFileJob", () => {
  it("saves and creates files as merge writes", async () => {
    expect(
      await planWorkspaceFileJob({
        request: { op: "save", path: "AGENTS.md", content: "# updated\n" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({
      ok: true,
      plan: {
        mergeFiles: [{ path: "AGENTS.md", content: "# updated\n" }],
        mergeDeletePaths: [],
      },
    })
    expect(
      await planWorkspaceFileJob({
        request: { op: "create", path: "notes.md", kind: "file" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({
      ok: true,
      plan: {
        mergeFiles: [{ path: "notes.md", content: "" }],
        mergeDeletePaths: [],
      },
    })
    expect(
      await planWorkspaceFileJob({
        request: { op: "create", path: "drafts", kind: "folder" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({
      ok: true,
      plan: {
        mergeFiles: [{ path: "drafts/.gitkeep", content: "" }],
        mergeDeletePaths: [],
      },
    })
  })

  it("rejects creating over an existing path", async () => {
    expect(
      await planWorkspaceFileJob({
        request: { op: "create", path: "AGENTS.md", kind: "file" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({ ok: false, error: "That path already exists." })
  })

  it("deletes a file or every blob under a folder", async () => {
    expect(
      await planWorkspaceFileJob({
        request: { op: "delete", path: "AGENTS.md" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({
      ok: true,
      plan: { mergeFiles: [], mergeDeletePaths: ["AGENTS.md"] },
    })
    expect(
      await planWorkspaceFileJob({
        request: { op: "delete", path: "knowledge/billing" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({
      ok: true,
      plan: {
        mergeFiles: [],
        mergeDeletePaths: [
          "knowledge/billing/ledger.md",
          "knowledge/billing/tax.md",
        ],
      },
    })
  })

  it("renames and moves by copying blobs then deleting the source", async () => {
    const readBlob = await blobs({
      "knowledge/billing/ledger.md": "ledger",
      "knowledge/billing/tax.md": "tax",
      "AGENTS.md": "agents",
    })
    expect(
      await planWorkspaceFileJob({
        request: { op: "rename", from: "AGENTS.md", to: "GUIDE.md" },
        treePaths: tree,
        readBlob,
      }),
    ).toEqual({
      ok: true,
      plan: {
        mergeFiles: [{ path: "GUIDE.md", content: "agents" }],
        mergeDeletePaths: ["AGENTS.md"],
      },
    })
    expect(
      await planWorkspaceFileJob({
        request: {
          op: "rename",
          from: "knowledge/billing",
          to: "knowledge/finance",
        },
        treePaths: tree,
        readBlob,
      }),
    ).toEqual({
      ok: true,
      plan: {
        mergeFiles: [
          { path: "knowledge/finance/ledger.md", content: "ledger" },
          { path: "knowledge/finance/tax.md", content: "tax" },
        ],
        mergeDeletePaths: [
          "knowledge/billing/ledger.md",
          "knowledge/billing/tax.md",
        ],
      },
    })
    expect(
      await planWorkspaceFileJob({
        request: {
          op: "move",
          from: "AGENTS.md",
          toDirectory: "knowledge",
        },
        treePaths: tree,
        readBlob,
      }),
    ).toEqual({
      ok: true,
      plan: {
        mergeFiles: [{ path: "knowledge/AGENTS.md", content: "agents" }],
        mergeDeletePaths: ["AGENTS.md"],
      },
    })
  })

  it("rejects a move into itself and missing blobs", async () => {
    expect(
      await planWorkspaceFileJob({
        request: {
          op: "move",
          from: "knowledge/billing",
          toDirectory: "knowledge/billing/nested",
        },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({
      ok: false,
      error: "Cannot move a folder into itself.",
    })
    expect(
      await planWorkspaceFileJob({
        request: { op: "rename", from: "AGENTS.md", to: "GUIDE.md" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({
      ok: false,
      error: "Could not read this path to move it.",
    })
  })

  it("rejects traversal in every op path", async () => {
    expect(
      await planWorkspaceFileJob({
        request: { op: "save", path: "../secret", content: "x" },
        treePaths: tree,
        readBlob: await blobs({}),
      }),
    ).toEqual({ ok: false, error: "A valid file path is required" })
  })
})

describe("parseWorkspaceFileJobRequest", () => {
  it("requires the fields for each op", () => {
    expect(
      parseWorkspaceFileJobRequest({
        op: "save",
        path: "AGENTS.md",
        content: "# x\n",
      }),
    ).toEqual({ op: "save", path: "AGENTS.md", content: "# x\n" })
    expect(
      parseWorkspaceFileJobRequest({ op: "save", path: "AGENTS.md" }),
    ).toBeNull()
    expect(
      parseWorkspaceFileJobRequest({
        op: "move",
        from: "AGENTS.md",
        toDirectory: null,
      }),
    ).toEqual({ op: "move", from: "AGENTS.md", toDirectory: null })
  })
})
