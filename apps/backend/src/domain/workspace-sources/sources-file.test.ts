import { describe, expect, it } from "vitest"
import {
  parseSourceEntry,
  sourceEntryToObject,
  sourcesFileSchema,
} from "./sources-file.js"

describe("sources file schema", () => {
  it("accepts version 1 and keeps entries unparsed", () => {
    const parsed = sourcesFileSchema.parse({ version: 1, sources: [{ id: 1 }] })
    expect(parsed.sources).toHaveLength(1)
    expect(
      sourcesFileSchema.safeParse({ version: 2, sources: [] }).success,
    ).toBe(false)
  })

  it("splits an entry into generic fields and provider scope", () => {
    expect(
      parseSourceEntry({
        id: "eng-docs",
        provider: "confluence",
        connection: "con_abc123",
        spaces: [{ key: "ENG", pages: "all" }],
      }),
    ).toEqual({
      ok: true,
      entry: {
        key: "eng-docs",
        provider: "confluence",
        connectionId: "con_abc123",
        scope: { spaces: [{ key: "ENG", pages: "all" }] },
      },
    })
  })

  it("keeps the usable fields of an invalid entry for its status row", () => {
    const parsed = parseSourceEntry({
      id: "eng-issues",
      provider: "jira",
      connection: "con_abc123",
    })
    expect(parsed).toMatchObject({
      ok: false,
      key: "eng-issues",
      provider: null,
      connectionId: "con_abc123",
    })
    expect(parsed.ok ? "" : parsed.detail).toContain("provider")
  })

  it("rejects an entry that is not a map", () => {
    expect(parseSourceEntry("nope")).toMatchObject({ ok: false, key: null })
  })
})

describe("sourceEntryToObject", () => {
  it("keeps the generic fields when the scope names them too", () => {
    expect(
      sourceEntryToObject({
        key: "docs",
        provider: "notion",
        connectionId: "con_n1",
        scope: {
          id: "evil",
          provider: "slack",
          connection: "con_x",
          pages: [],
        },
      }),
    ).toEqual({
      id: "docs",
      provider: "notion",
      connection: "con_n1",
      pages: [],
    })
  })
})
