import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { gitBlobSha, readSourcesStamp, stampSources } from "./stamp-sources.js"

const page = "---\nsource: linear\nid: a\n---\n# Title\n\nBody\n"

describe("stampSources", () => {
  it("adds the sources list as the last front matter key", () => {
    expect(stampSources(page, ["sources/linear/team.md"])).toBe(
      "---\nsource: linear\nid: a\nsources:\n  - sources/linear/team.md\n---\n# Title\n\nBody\n",
    )
  })

  it("replaces an existing list and is idempotent", () => {
    const once = stampSources(page, ["sources/linear/old.md"])
    const twice = stampSources(once, ["sources/linear/new.md"])
    expect(twice).toBe(stampSources(page, ["sources/linear/new.md"]))
    expect(stampSources(twice, ["sources/linear/new.md"])).toBe(twice)
  })

  it("leaves a file without front matter as it is", () => {
    expect(stampSources("# Plain\n", ["sources/linear/a.md"])).toBe("# Plain\n")
  })

  it("stamps an empty front matter and strips it back to the same text", () => {
    const empty = "---\n---\n# Title\n"
    const stamped = stampSources(empty, ["sources/linear/a.md"])
    expect(stamped).toBe(
      "---\nsources:\n  - sources/linear/a.md\n---\n# Title\n",
    )
    expect(readSourcesStamp(stamped)).toEqual({
      sources: ["sources/linear/a.md"],
      stripped: empty,
    })
  })

  it("keeps a key that follows the list", () => {
    const text = "---\nsources:\n  - sources/linear/a.md\nid: a\n---\nBody\n"
    expect(stampSources(text, ["sources/linear/b.md"])).toBe(
      "---\nid: a\nsources:\n  - sources/linear/b.md\n---\nBody\n",
    )
  })
})

describe("readSourcesStamp", () => {
  it("returns the list and the text without it", () => {
    const stamped = stampSources(page, ["sources/linear/team.md"])
    expect(readSourcesStamp(stamped)).toEqual({
      sources: ["sources/linear/team.md"],
      stripped: page,
    })
  })

  it("returns a null list for a file with no list", () => {
    expect(readSourcesStamp(page)).toEqual({ sources: null, stripped: page })
  })

  it("returns null for a file with no front matter", () => {
    expect(readSourcesStamp("# Plain\n")).toBeNull()
  })
})

describe("gitBlobSha", () => {
  it("matches git hash-object", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha("hello\n")).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    )
    expect(createHash("sha1").update("x").digest("hex")).toHaveLength(40)
  })
})
