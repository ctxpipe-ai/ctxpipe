import { describe, expect, it } from "vitest"
import {
  MarkdownParseError,
  parseRecord,
  serializeRecord,
  type MemoryRecord,
} from "../../src/memory/markdown.js"

const SAMPLE: MemoryRecord = {
  id: "mem-auth-session-refresh",
  type: "architecture",
  title: "Auth Session Refresh",
  body: "# Auth Session Refresh\n\nWe use Better Auth session refresh through ...",
  concepts: ["auth", "sessions", "better-auth"],
  files: ["apps/backend/src/auth.ts"],
  createdAt: "2026-05-25T00:00:00.000Z",
  updatedAt: "2026-05-25T00:00:00.000Z",
  extra: {},
}

describe("memory/markdown", () => {
  it("round-trips a canonical record", () => {
    const serialized = serializeRecord(SAMPLE)
    expect(serialized).toMatch(/^---\nid: mem-auth-session-refresh\n/)
    expect(serialized).toContain("type: architecture")
    expect(serialized).toContain("- apps/backend/src/auth.ts")
    const parsed = parseRecord(serialized)
    expect(parsed.id).toBe(SAMPLE.id)
    expect(parsed.type).toBe(SAMPLE.type)
    expect(parsed.concepts).toEqual(SAMPLE.concepts)
    expect(parsed.files).toEqual(SAMPLE.files)
    expect(parsed.createdAt).toBe(SAMPLE.createdAt)
    expect(parsed.updatedAt).toBe(SAMPLE.updatedAt)
    expect(parsed.title).toBe(SAMPLE.title)
    expect(parsed.body).toContain("Better Auth session refresh")
  })

  it("preserves unknown frontmatter keys through round trip", () => {
    const serialized = serializeRecord({
      ...SAMPLE,
      extra: { strength: "9", version: "2" },
    })
    const parsed = parseRecord(serialized)
    expect(parsed.extra).toEqual({ strength: "9", version: "2" })
  })

  it("rejects missing frontmatter", () => {
    expect(() => parseRecord("# just a heading\n\nno frontmatter")).toThrow(
      MarkdownParseError,
    )
  })

  it("rejects records that omit required fields", () => {
    const broken = `---\nid: foo\ntype: note\ncreatedAt: 2026-05-25T00:00:00.000Z\n---\n# foo\n`
    // missing updatedAt
    expect(() => parseRecord(broken)).toThrow(/updatedAt/)
  })

  it("refuses unresolved merge-conflict markers", () => {
    const conflicted = `---\nid: x\ntype: note\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# x\n<<<<<<< HEAD\nthing\n=======\nother\n>>>>>>> branch\n`
    expect(() => parseRecord(conflicted)).toThrow(/merge conflict/i)
  })

  it("parses inline flow-style lists", () => {
    const src = `---\nid: y\ntype: note\nconcepts: [a, b, c]\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# y\nhello\n`
    const parsed = parseRecord(src)
    expect(parsed.concepts).toEqual(["a", "b", "c"])
    expect(parsed.files).toEqual([])
  })

  it("derives a title from the first heading when present", () => {
    const src = `---\nid: z\ntype: note\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# Better Auth Session Refresh\nbody`
    expect(parseRecord(src).title).toBe("Better Auth Session Refresh")
  })

  it("falls back to id when no heading is present", () => {
    const src = `---\nid: zz\ntype: note\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\nbody`
    expect(parseRecord(src).title).toBe("zz")
  })
})
