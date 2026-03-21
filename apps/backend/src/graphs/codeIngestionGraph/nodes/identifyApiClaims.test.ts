import { describe, expect, it } from "vitest"
import { extractOperationsFromOpenApiSpec } from "./identifyApiClaims.js"

describe("extractOperationsFromOpenApiSpec", () => {
  it("extracts methods from openapi 3 paths", () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/users": { get: {}, post: {} },
        "/items/{id}": { get: {} },
      },
    }
    const ops = extractOperationsFromOpenApiSpec(spec)
    expect(ops).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/users" },
        { method: "POST", path: "/users" },
        { method: "GET", path: "/items/{id}" },
      ]),
    )
    expect(ops).toHaveLength(3)
  })
})
