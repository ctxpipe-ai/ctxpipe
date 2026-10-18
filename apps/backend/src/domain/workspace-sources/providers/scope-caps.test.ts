import { describe, expect, it } from "vitest"
import { parseSourceEntry } from "../sources-file.js"

const parse = (provider: string, scope: Record<string, unknown>) =>
  parseSourceEntry({ id: "a-source", provider, connection: "con_abc", ...scope })

/** Make `count` distinct values with `make`. */
const many = <T>(count: number, make: (index: number) => T) =>
  Array.from({ length: count }, (_, index) => make(index))

const notionId = (index: number) =>
  `1a2b3c4d-0000-4000-8000-${index.toString(16).padStart(12, "0")}`

describe("a source scope list has a maximum length", () => {
  it("stops a PagerDuty source at 50 services, with a clear message", () => {
    const service = (index: number) => `PSVC${index.toString(36).toUpperCase()}`
    expect(parse("pagerduty", { services: many(50, service) }).ok).toBe(true)
    const result = parse("pagerduty", { services: many(51, service) })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.detail).toContain(
        "Select at most 50 PagerDuty services for one source",
      )
  })

  it("stops a Linear source at 50 teams and 100 projects", () => {
    const key = (index: number) => `T${index}`
    expect(parse("linear", { teams: many(50, key) }).ok).toBe(true)
    expect(parse("linear", { teams: many(51, key) }).ok).toBe(false)
    expect(parse("linear", { projects: many(100, key) }).ok).toBe(true)
    expect(parse("linear", { projects: many(101, key) }).ok).toBe(false)
  })

  it("stops a Notion source at 100 pages and 100 databases", () => {
    expect(parse("notion", { pages: many(100, (i) => ({ id: notionId(i), title: "P" })) }).ok).toBe(true)
    expect(parse("notion", { pages: many(101, (i) => ({ id: notionId(i), title: "P" })) }).ok).toBe(false)
    expect(parse("notion", { databases: many(101, (i) => ({ id: notionId(i), title: "D" })) }).ok).toBe(false)
  })

  it("stops a Slack source at 100 channels", () => {
    const channel = (index: number) => `C${index.toString(36).toUpperCase().padStart(8, "0")}`
    expect(parse("slack", { channels: many(100, channel) }).ok).toBe(true)
    expect(parse("slack", { channels: many(101, channel) }).ok).toBe(false)
  })

  it("stops a Confluence source at 50 spaces and 1000 pages in one space", () => {
    const space = (index: number) => ({ key: `S${index}`, pages: "all" })
    expect(parse("confluence", { spaces: many(50, space) }).ok).toBe(true)
    expect(parse("confluence", { spaces: many(51, space) }).ok).toBe(false)
    const pages = (count: number) => ({
      spaces: [{ key: "ENG", pages: many(count, (i) => String(i + 1)) }],
    })
    expect(parse("confluence", pages(1000)).ok).toBe(true)
    expect(parse("confluence", pages(1001)).ok).toBe(false)
  })
})
