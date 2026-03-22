import { describe, expect, it } from "vitest"
import { mergeRetrievalObjectPayloads } from "./retrievalObjectWrite.js"

describe("mergeRetrievalObjectPayloads", () => {
  it("keeps rich fields when incoming is consumer stub", () => {
    const existing = {
      path: "apps/web/src/app/api",
      framework: "Next.js",
      operations: [{ method: "GET", path: "/users" }],
    }
    const incoming = {
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
    }
    expect(mergeRetrievalObjectPayloads(existing, incoming)).toEqual({
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
      framework: "Next.js",
      operations: [{ method: "GET", path: "/users" }],
    })
  })

  it("replaces stub when incoming is full extraction", () => {
    const existing = {
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
    }
    const incoming = {
      path: "apps/web/src/app/api",
      framework: "Hono",
    }
    expect(mergeRetrievalObjectPayloads(existing, incoming)).toEqual({
      path: "apps/web/src/app/api",
      inferredFromConsumer: true,
      framework: "Hono",
    })
  })

  it("prefers incoming for two non-stub payloads", () => {
    const existing = { name: "a", x: 1 }
    const incoming = { name: "b", y: 2 }
    expect(mergeRetrievalObjectPayloads(existing, incoming)).toEqual({
      name: "b",
      x: 1,
      y: 2,
    })
  })
})
