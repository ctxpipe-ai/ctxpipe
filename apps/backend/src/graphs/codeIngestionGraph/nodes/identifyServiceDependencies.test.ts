import { describe, expect, it } from "vitest"
import { postProcessServiceDependencies } from "./identifyServiceDependencies.js"

describe("identifyServiceDependencies post-processing", () => {
  const state = {
    repositoryId: "repo_abc",
    roots: ["./", "apps/web", "apps/api", "packages/shared"],
    targetHash: "abc123",
  }

  it("produces DEPENDS_ON Service→Service claims only", () => {
    const captured = [
      {
        consumerPath: "apps/web",
        providerPath: "packages/shared",
        evidence: "package.json workspace:*",
      },
      {
        consumerPath: "apps/web",
        providerPath: "apps/api",
        evidence: "fetch(API_URL)",
      },
    ]
    const claims = postProcessServiceDependencies(captured, state)

    expect(claims).toHaveLength(2)

    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo_abc:apps/web",
      subjectKind: "Service",
      objectRef: "svc:repo_abc:packages/shared",
      objectKind: "Service",
      predicate: "DEPENDS_ON",
      sourceId:
        "identifyServiceDependencies:repo_abc:apps/web:packages/shared:abc123",
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.8,
      provenance: {
        consumerPath: "apps/web",
        providerPath: "packages/shared",
        evidence: "package.json workspace:*",
      },
    })

    expect(claims[1]).toMatchObject({
      subjectRef: "svc:repo_abc:apps/web",
      subjectKind: "Service",
      objectRef: "svc:repo_abc:apps/api",
      objectKind: "Service",
      predicate: "DEPENDS_ON",
    })
  })

  it("deduplicates claims by consumer→provider pair", () => {
    const captured = [
      {
        consumerPath: "apps/web",
        providerPath: "packages/shared",
        evidence: "a",
      },
      {
        consumerPath: "apps/web",
        providerPath: "packages/shared",
        evidence: "b",
      },
    ]
    const claims = postProcessServiceDependencies(captured, state)

    expect(claims).toHaveLength(1)
    expect(claims[0].subjectRef).toBe("svc:repo_abc:apps/web")
    expect(claims[0].objectRef).toBe("svc:repo_abc:packages/shared")
  })

  it("filters out dependencies where consumer or provider is not in roots", () => {
    const captured = [
      { consumerPath: "apps/web", providerPath: "packages/shared" },
      { consumerPath: "apps/web", providerPath: "apps/unknown" },
      { consumerPath: "apps/unknown", providerPath: "packages/shared" },
    ]
    const claims = postProcessServiceDependencies(captured, state)

    expect(claims).toHaveLength(1)
    expect(claims[0].objectRef).toBe("svc:repo_abc:packages/shared")
  })

  it("filters out self-dependencies (consumer === provider)", () => {
    const captured = [{ consumerPath: "apps/web", providerPath: "apps/web" }]
    const claims = postProcessServiceDependencies(captured, state)

    expect(claims).toHaveLength(0)
  })

  it("resolves paths to most specific matching root", () => {
    const captured = [
      {
        consumerPath: "apps/web/src",
        providerPath: "packages/shared/utils",
        evidence: "import",
      },
    ]
    const claims = postProcessServiceDependencies(captured, state)

    expect(claims).toHaveLength(1)
    expect(claims[0].subjectRef).toBe("svc:repo_abc:apps/web")
    expect(claims[0].objectRef).toBe("svc:repo_abc:packages/shared")
  })

  it("produces no claims when roots exclude both consumer and provider", () => {
    const captured = [
      { consumerPath: "apps/web", providerPath: "packages/shared" },
    ]
    const claims = postProcessServiceDependencies(captured, {
      ...state,
      roots: ["apps/other"],
    })

    expect(claims).toHaveLength(0)
  })

  it("handles root ./ for path matching", () => {
    const captured = [
      { consumerPath: "apps/web", providerPath: "packages/shared" },
    ]
    const claims = postProcessServiceDependencies(captured, {
      ...state,
      roots: ["./"],
    })

    // When roots = ["./"], both paths resolve to "./" -> self-dependency, filtered out
    expect(claims).toHaveLength(0)
  })
})
