import { describe, expect, it } from "vitest"
import { stringify } from "yaml"

import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import { renderGithubPullRequest } from "../services/github/pull-request-mirror/converter.js"
import { renderLinearIssue } from "../services/linear/converter.js"
import { parseKnowledgeFile, workspaceBlobPath } from "./parse-file.js"
import { knowledgeRows } from "./rows.js"

const workspaceUrl = "https://github.com/example/handbook.git"

function parse(path: string, content: string, root = "") {
  return parseKnowledgeFile({
    workspaceId: "ws_parse",
    blobPath: workspaceBlobPath(workspaceUrl, root),
    path,
    content,
    sourceRepositories: new Map(),
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
      references: { keys: [], links: [] },
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

  it("states the keys of a Linear issue file, and names the keys of a Linear identifier and URL in another file (CTX-1400)", () => {
    const issue = renderLinearIssue({
      id: "issue-uuid-1",
      identifier: "ENG-1",
      title: "Build the ledger",
      url: "https://linear.app/acme/issue/ENG-1/build-the-ledger",
      priorityLabel: "No priority",
      teamKey: "ENG",
      labels: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      completedAt: null,
      canceledAt: null,
      comments: [],
      attachments: [],
      description: "Blocked by ENG-2. Built for ENG-1 itself.",
    })
    const own = parse(issue.path, issue.content)
    if (own.kind !== "unit") throw new Error(own.kind)
    // A Linear identifier and the URL of its Linear workspace.
    expect(own.references.keys).toEqual([
      "iss:linear:ENG-1",
      "iss:linear:ENG-1@acme",
    ])
    // A file gives no link to a key that it states itself.
    expect(own.references.links.map((link) => link.key)).toEqual([
      "iss:linear:ENG-2",
    ])

    const note = parse(
      "notes/a.md",
      [
        "# A",
        "",
        "Fixes ENG-1 and [the ledger](https://linear.app/acme/issue/ENG-1/x).",
        "Not https://linear.app/other/issue/ENG-1 of another Linear workspace.",
        "See https://acme.slack.com/archives/C0123ABCD/p1700000000123456.",
      ].join("\n"),
    )
    if (note.kind !== "unit") throw new Error(note.kind)
    expect(note.references.keys).toEqual([])
    expect(
      note.references.links.map(({ key, predicate }) => [predicate, key]),
    ).toEqual([
      ["LINKS_TO", "iss:linear:ENG-1@acme"],
      ["LINKS_TO", "iss:linear:ENG-1@other"],
      ["LINKS_TO", "thr:slack:C0123ABCD:1700000000.123456"],
      ["LINKS_TO", "iss:linear:ENG-1"],
    ])
    // The relation records the chunk that names the key.
    const rows = knowledgeRows({
      workspaceId: "ws_parse",
      unit: note.unit,
      references: note.references,
      observedAt: new Date("2026-11-19T00:00:00.000Z"),
    })
    expect(rows.refKeys).toEqual([])
    expect(
      rows.relations.find(
        (relation) => relation.dstDoc === "ref:iss:linear:ENG-1",
      ),
    ).toMatchObject({ predicate: "LINKS_TO", srcChunk: 0, confidence: 1 })
  })

  it("gives a package file the CHANGED key of its root, and a merged pull request the keys of each folder of its changed files", () => {
    const sourceRepositories = new Map([
      ["sources/github/acme/shop.md", "https://github.com/acme/shop"],
    ])
    const service = parseKnowledgeFile({
      workspaceId: "ws_parse",
      blobPath: () => null,
      path: "knowledge/services/api.md",
      content: `---\n${stringify({
        kind: "Service",
        generated_by: "ctxpipe-extract",
        root: "apps/api",
        sources: ["sources/github/acme/shop.md"],
      })}---\n# API\n`,
      sourceRepositories,
    })
    if (service.kind !== "unit") throw new Error(service.kind)
    expect(service.references).toEqual({
      keys: ["changed:https://github.com/acme/shop#apps/api"],
      links: [],
    })

    const pull = renderGithubPullRequest({
      id: 9001,
      number: 42,
      repository: "acme/shop",
      url: "https://github.com/acme/shop/pull/42",
      title: "Change the checkout",
      body: "",
      state: "closed",
      merged: true,
      mergedAt: "2026-09-01T10:00:00Z",
      draft: false,
      author: { login: "dev", type: "human" },
      base: { ref: "main", sha: "a".repeat(40) },
      head: { ref: "change", sha: "b".repeat(40) },
      reviewDecision: null,
      labels: [],
      requestedReviewers: [],
      createdAt: "2026-08-30T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
      files: [
        { path: "apps/api/src/checkout.ts", status: "modified" },
        { path: "README.md", status: "modified" },
      ],
      reviews: [],
      comments: [],
      requiredChecks: [],
    })
    const parsed = parse(pull.path, pull.content)
    if (parsed.kind !== "unit") throw new Error(parsed.kind)
    expect(parsed.references.keys).toEqual(["ghn:acme/shop#42"])
    expect(
      parsed.references.links
        .filter((link) => link.predicate === "CHANGED")
        .map(({ key, validFrom }) => [key, validFrom]),
    ).toEqual(
      [
        "changed:https://github.com/acme/shop",
        "changed:https://github.com/acme/shop#",
        "changed:https://github.com/acme/shop#apps",
        "changed:https://github.com/acme/shop#apps/api",
        "changed:https://github.com/acme/shop#apps/api/src",
      ].map((key) => [key, "2026-09-01T10:00:00Z"]),
    )
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
