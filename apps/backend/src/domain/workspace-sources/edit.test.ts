import { describe, expect, it } from "vitest"
import { applySourceFileChange, SourceChangeError } from "./edit.js"
import { parseSourceFile } from "./source-file-text.js"

const linear = `---
provider: linear
connection: con_linear1
teams: [ENG]
---
Product issues.
Keep this line.
`

const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    if (error instanceof SourceChangeError) return error.status
    throw error
  }
  return null
}

describe("applySourceFileChange", () => {
  it("adds one file and picks a free path from the provider", () => {
    const first = applySourceFileChange({
      files: [],
      change: {
        action: "add",
        provider: "slack",
        connectionId: "con_slack1",
        scope: { channels: ["C0123ABCD"] },
      },
    })
    expect(first.path).toBe("sources/slack/slack.md")
    expect(first.deletes).toEqual([])
    expect(first.writes).toHaveLength(1)
    const second = applySourceFileChange({
      files: first.writes,
      change: {
        action: "add",
        provider: "slack",
        connectionId: "con_slack1",
        scope: { channels: ["C0456EFGH"] },
      },
    })
    expect(second.path).toBe("sources/slack/slack-2.md")
  })

  it("names a GitHub file by its repository and writes the description as the body", () => {
    const result = applySourceFileChange({
      files: [],
      change: {
        action: "add",
        provider: "github",
        connectionId: "con_gh",
        scope: { repository: "Acme/Checkout-API", ref: "stable" },
        description: "The checkout service.",
      },
    })
    expect(result.path).toBe("sources/github/acme/checkout-api.md")
    const parsed = parseSourceFile(result.path, result.writes[0]?.content ?? "")
    expect(parsed).toMatchObject({
      ok: true,
      body: "The checkout service.\n",
      source: { scope: { repository: "Acme/Checkout-API", ref: "stable" } },
    })
  })

  it("refuses a path that exists, an open pull request path, and a repository that another file links", () => {
    const add = {
      action: "add" as const,
      provider: "linear" as const,
      connectionId: "con_linear1",
      scope: { teams: ["CTX"] },
    }
    const files = [{ path: "sources/linear/eng.md", content: linear }]
    expect(
      status(() =>
        applySourceFileChange({
          files,
          change: { ...add, path: "sources/linear/eng.md" },
        }),
      ),
    ).toBe(409)
    const reservedPaths = new Set(["sources/linear/linear.md"])
    // A picked path skips it; a path from the caller gets a 409.
    expect(
      applySourceFileChange({ files, change: add, reservedPaths }).path,
    ).toBe("sources/linear/linear-2.md")
    expect(
      status(() =>
        applySourceFileChange({
          files,
          change: { ...add, path: "sources/linear/linear.md" },
          reservedPaths,
        }),
      ),
    ).toBe(409)
    const github = {
      action: "add" as const,
      provider: "github" as const,
      connectionId: "con_gh",
      scope: { repository: "acme/web" },
    }
    const linked = applySourceFileChange({ files: [], change: github })
    expect(
      status(() =>
        applySourceFileChange({
          files: linked.writes,
          change: { ...github, path: "sources/github/acme/other.md" },
        }),
      ),
    ).toBe(409)
  })

  it("edits the front matter and keeps the body byte for byte", () => {
    const result = applySourceFileChange({
      files: [{ path: "sources/linear/eng.md", content: linear }],
      change: {
        action: "edit",
        path: "sources/linear/eng.md",
        provider: "linear",
        connectionId: "con_linear1",
        scope: { teams: ["ENG", "OPS"] },
      },
    })
    expect(result.writes).toHaveLength(1)
    const parsed = parseSourceFile(
      "sources/linear/eng.md",
      result.writes[0]?.content ?? "",
    )
    expect(parsed).toMatchObject({
      ok: true,
      body: "Product issues.\nKeep this line.\n",
      source: { scope: { teams: ["ENG", "OPS"] } },
    })
  })

  it("changes the body only when a description comes with the edit", () => {
    const edit = {
      action: "edit" as const,
      path: "sources/linear/eng.md",
      provider: "linear" as const,
      connectionId: "con_linear1",
      scope: { teams: ["ENG"] },
    }
    const files = [{ path: "sources/linear/eng.md", content: linear }]
    const result = applySourceFileChange({
      files,
      change: { ...edit, description: "New text." },
    })
    expect(result.writes[0]?.content.endsWith("---\nNew text.\n")).toBe(true)
  })

  it("removes one file", () => {
    const result = applySourceFileChange({
      files: [{ path: "sources/linear/eng.md", content: linear }],
      change: { action: "remove", path: "sources/linear/eng.md" },
    })
    expect(result.writes).toEqual([])
    expect(result.deletes).toEqual(["sources/linear/eng.md"])
    expect(result.provider).toBe("linear")
  })

  it("renames a file byte for byte and changes the sources list of each unit that names it", () => {
    const unit = `---\ntitle: Issue\nsources:\n  - sources/linear/eng.md\n  - sources/linear/other.md\n---\nBody stays.\n`
    const unrelated = `---\nsources:\n  - sources/linear/other.md\n---\nx\n`
    const result = applySourceFileChange({
      files: [{ path: "sources/linear/eng.md", content: linear }],
      unitFiles: [
        { path: "linear/ENG-1.md", content: unit },
        { path: "notes.md", content: unrelated },
        { path: "plain.md", content: "no front matter\n" },
      ],
      change: {
        action: "rename",
        path: "sources/linear/eng.md",
        newPath: "sources/linear/engineering.md",
      },
    })
    expect(result.deletes).toEqual(["sources/linear/eng.md"])
    expect(result.path).toBe("sources/linear/engineering.md")
    expect(result.writes).toEqual([
      { path: "sources/linear/engineering.md", content: linear },
      {
        path: "linear/ENG-1.md",
        content: `---\ntitle: Issue\nsources:\n  - sources/linear/engineering.md\n  - sources/linear/other.md\n---\nBody stays.\n`,
      },
    ])
  })

  it("refuses a rename to another provider folder, to a taken path, and from an unknown path", () => {
    const files = [
      { path: "sources/linear/eng.md", content: linear },
      { path: "sources/linear/ops.md", content: linear },
    ]
    const rename = (path: string, newPath: string) => () =>
      applySourceFileChange({
        files,
        change: { action: "rename", path, newPath },
      })
    expect(
      status(rename("sources/linear/eng.md", "sources/slack/eng.md")),
    ).toBe(400)
    expect(
      status(rename("sources/linear/eng.md", "sources/linear/ops.md")),
    ).toBe(409)
    expect(
      status(rename("sources/linear/nope.md", "sources/linear/x.md")),
    ).toBe(404)
    expect(
      status(rename("sources/linear/eng.md", "sources/linear/../x.md")),
    ).toBe(400)
  })

  it("refuses an unknown path, a bad path, a bad scope, and a path outside sources/", () => {
    const add = {
      action: "add" as const,
      provider: "linear" as const,
      connectionId: "con_linear1",
      scope: { teams: ["ENG"] },
    }
    expect(
      status(() =>
        applySourceFileChange({
          files: [],
          change: { action: "remove", path: "sources/linear/nope.md" },
        }),
      ),
    ).toBe(404)
    expect(
      status(() =>
        applySourceFileChange({
          files: [],
          change: { ...add, path: "sources/Linear/Bad Name.md" },
        }),
      ),
    ).toBe(400)
    expect(
      status(() =>
        applySourceFileChange({
          files: [],
          change: { ...add, path: ".ctxpipe/sources.yaml" },
        }),
      ),
    ).toBe(400)
    expect(
      status(() =>
        applySourceFileChange({
          files: [],
          change: { ...add, scope: { teams: [], bogus: 1 } },
        }),
      ),
    ).toBe(400)
    expect(
      status(() =>
        applySourceFileChange({
          files: [],
          change: { ...add, path: "sources/slack/x.md" },
        }),
      ),
    ).toBe(400)
  })

  it("refuses an edit that changes the provider and an edit of a file that does not parse", () => {
    expect(
      status(() =>
        applySourceFileChange({
          files: [{ path: "sources/linear/eng.md", content: linear }],
          change: {
            action: "edit",
            path: "sources/linear/eng.md",
            provider: "slack",
            connectionId: "con_slack1",
            scope: { channels: ["C0123ABCD"] },
          },
        }),
      ),
    ).toBe(400)
    // An edit rewrites the front matter and keeps the body, so a file
    // without front matter has no body to keep.
    expect(
      status(() =>
        applySourceFileChange({
          files: [
            { path: "sources/linear/eng.md", content: "no front matter" },
          ],
          change: {
            action: "edit",
            path: "sources/linear/eng.md",
            provider: "linear",
            connectionId: "con_linear1",
            scope: { teams: ["ENG"] },
          },
        }),
      ),
    ).toBe(409)
  })
})
