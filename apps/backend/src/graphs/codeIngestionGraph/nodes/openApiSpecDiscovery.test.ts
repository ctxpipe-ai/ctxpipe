import { describe, expect, it } from "vitest"
import {
  apiDirectoryFromSpecPath,
  parseOpenApiContent,
} from "./openApiSpecDiscovery.js"

describe("apiDirectoryFromSpecPath", () => {
  it("returns ./ for root-level spec", () => {
    expect(apiDirectoryFromSpecPath("openapi.json")).toBe("./")
  })

  it("returns parent directory for nested spec", () => {
    expect(apiDirectoryFromSpecPath("apps/web/openapi.json")).toBe("apps/web")
  })
})

describe("parseOpenApiContent", () => {
  it("parses minimal openapi json", () => {
    const raw = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/x": { get: {} } },
    })
    const spec = parseOpenApiContent(raw, "x.json")
    expect(spec?.openapi).toBe("3.0.0")
  })

  it("parses minimal swagger json", () => {
    const raw = JSON.stringify({
      swagger: "2.0",
      paths: { "/y": { get: {} } },
    })
    expect(parseOpenApiContent(raw, "y.json")?.swagger).toBe("2.0")
  })
})
