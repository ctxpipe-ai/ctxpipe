import { describe, expect, it } from "vitest"

import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import { parseKnowledgeFile, workspaceBlobPath } from "./parse-file.js"
import { knowledgeRows } from "./rows.js"

const workspaceUrl = "https://github.com/example/handbook.git"

function parse(path: string, content: string, root = "") {
  return parseKnowledgeFile({
    workspaceId: "ws_parse",
    blobPath: workspaceBlobPath(workspaceUrl, root),
    path,
    content,
  })
}

function unitOf(path: string, content: string, root = "") {
  const parsed = parse(path, content, root)
  if (parsed.kind !== "unit") throw new Error(`No unit: ${parsed.kind}`)
  return parsed.unit
}

describe("parseKnowledgeFile", () => {
  it("claims each source of the front matter, whether the source file exists or not", () => {
    const unit = unitOf(
      "notes/a.md",
      "---\nsources:\n  - sources/repo.md\n  - https://example.com/x\n---\n# A\n",
    )
    expect(unit.claims).toEqual([
      {
        to: "workspace:sources/repo.md",
        predicate: "FROM_SOURCE",
        confidence: 1,
        validFrom: null,
        validTo: null,
        source: "git",
      },
    ])
  })

  it("links a blob URL of the Workspace repository to its path, whether the file exists or not", () => {
    const unit = unitOf(
      "notes/a.md",
      [
        "# A",
        "See https://github.com/example/handbook/blob/main/docs/missing.md",
        "and https://github.com/example/handbook/blob/main/notes/a.md (itself)",
        "and https://github.com/example/other/blob/main/docs/x.md (another repository)",
        "and https://github.com/example/handbook/blob/main/%E0%A4%A.md (a bad escape).",
      ].join("\n"),
    )
    expect(unit.links).toEqual(["workspace:docs/missing.md"])
  })

  it("links a blob URL to its path from the Workspace root, and not to a file outside the root", () => {
    const unit = unitOf(
      "notes/a.md",
      [
        "See https://github.com/example/handbook/blob/main/docs/x.md",
        "and https://github.com/example/handbook/blob/main/README.md (outside).",
      ].join("\n"),
      "docs",
    )
    expect(unit.links).toEqual(["workspace:x.md"])
  })

  it("maps an inline or reference-style image with a blob URL to an EMBEDS_IMAGE relation, not a link", () => {
    const unit = unitOf(
      "notes/a.md",
      [
        "# A",
        "",
        "![flow](https://github.com/example/handbook/blob/main/docs/flow.png)",
        "![map][map]",
        "",
        "[map]: https://github.com/example/handbook/blob/main/docs/map.png",
      ].join("\n"),
      "docs",
    )
    const rows = knowledgeRows({
      workspaceId: "ws_parse",
      unit,
      blobPath: workspaceBlobPath(workspaceUrl, "docs"),
      observedAt: new Date("2026-11-19T00:00:00.000Z"),
    })
    expect(
      rows.relations.map(({ predicate, dstDoc }) => ({ predicate, dstDoc })),
    ).toEqual(
      ["flow.png", "map.png"].map((path) => ({
        predicate: "EMBEDS_IMAGE",
        dstDoc: servingIdForKnowledgePath("ws_parse", path),
      })),
    )
  })

  it("gives no key-based mirror reference link yet (CTX-1400)", () => {
    const unit = unitOf(
      "linear/teams/ENG/issues/ENG-1.md",
      "---\nidentifier: ENG-1\n---\n# Issue\n\nBlocked by ENG-2.\n",
    )
    expect(unit.links).toEqual([])
  })

  it("gives a failed document for a file that does not parse, and none for a file that is not knowledge", () => {
    expect(parse("a.md", "---\ntitle: broken\n")).toEqual({
      kind: "failed",
      error: "malformed",
    })
    expect(
      parse("a.md", "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n"),
    ).toEqual({ kind: "failed", error: "merge_conflict" })
    expect(parse("AGENTS.md", "# Agents\n")).toEqual({ kind: "none" })
    expect(parse("img/d.png", "")).toEqual({ kind: "none" })
  })
})
