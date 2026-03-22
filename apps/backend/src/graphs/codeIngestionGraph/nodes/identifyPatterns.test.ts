import { describe, expect, it } from "vitest"
import { postProcessPatterns } from "./identifyPatterns.js"

describe("identifyPatterns post-processing", () => {
  const state = {
    repositoryId: "repo_abc",
    roots: ["./", "apps/web"],
    targetHash: "abc123",
  }

  it("produces Pattern objects and IMPLEMENTS_PATTERN claims", () => {
    const captured = [
      {
        patternName: "CQRS",
        path: "./",
        evidence: "separate read/write models",
      },
      {
        patternName: "Repository",
        path: "apps/web",
        evidence: "UserRepository",
      },
    ]
    const { objects, claims } = postProcessPatterns(captured, state)

    expect(objects).toHaveLength(2)

    const patternObjects = objects.filter((o) => o.kind === "Pattern")
    expect(patternObjects).toHaveLength(2)

    expect(patternObjects[0]).toMatchObject({
      kind: "Pattern",
      deduplicationKey: "pat:repo_abc:./:CQRS",
      name: "CQRS",
      summary: "CQRS implemented by ./",
      payload: { evidence: "separate read/write models" },
    })

    expect(patternObjects[1]).toMatchObject({
      kind: "Pattern",
      deduplicationKey: "pat:repo_abc:apps/web:Repository",
      name: "Repository",
      summary: "Repository implemented by apps/web",
    })

    expect(claims).toHaveLength(2)
    expect(claims.every((c) => c.predicate === "IMPLEMENTS_PATTERN")).toBe(true)
    expect(
      claims.every(
        (c) => c.subjectKind === "Service" && c.objectKind === "Pattern",
      ),
    ).toBe(true)
    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo_abc:./",
      objectRef: "pat:repo_abc:./:CQRS",
      predicate: "IMPLEMENTS_PATTERN",
      sourceId: "identifyPatterns:repo_abc:./:CQRS:abc123",
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.6,
    })
  })

  it("deduplicates by pattern name per root", () => {
    const captured = [
      { patternName: "CQRS", path: "./" },
      { patternName: "cqrs", path: "./" },
      { patternName: "Saga", path: "./" },
    ]
    const { objects, claims } = postProcessPatterns(captured, state)

    expect(objects).toHaveLength(2) // CQRS (deduped), Saga
    const names = objects.map((o) => o.name).sort()
    expect(names).toEqual(["CQRS", "Saga"])
  })

  it("normalizes pattern names for deduplication", () => {
    const captured = [
      { patternName: "event sourcing", path: "./" },
      { patternName: "Event Sourcing", path: "./" },
    ]
    const { objects } = postProcessPatterns(captured, state)
    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("Event Sourcing")
    expect(objects[0].deduplicationKey).toBe("pat:repo_abc:./:Event Sourcing")
  })

  it("filters by pathMatchesRoot", () => {
    const captured = [
      { patternName: "Repository", path: "apps/api" },
      { patternName: "Factory", path: "packages/shared" },
    ]
    const { objects } = postProcessPatterns(captured, {
      ...state,
      roots: ["apps/api"],
    })
    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("Repository")
    expect(objects[0].deduplicationKey).toBe("pat:repo_abc:apps/api:Repository")
  })

  it("produces correct output shape for objects and claims", () => {
    const captured = [
      { patternName: "Saga", path: "./", evidence: "saga orchestrator" },
    ]
    const { objects, claims } = postProcessPatterns(captured, state)

    expect(objects[0]).toMatchObject({
      kind: "Pattern",
      deduplicationKey: expect.stringMatching(/^pat:repo_abc:\.\/:.*/),
      name: expect.any(String),
      summary: expect.any(String),
    })

    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo_abc:./",
      subjectKind: "Service",
      objectRef: expect.stringMatching(/^pat:repo_abc:\.\/:.*/),
      objectKind: "Pattern",
      predicate: "IMPLEMENTS_PATTERN",
      sourceId: expect.any(String),
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.6,
      provenance: expect.objectContaining({ root: "./" }),
    })
  })

  it("uses confidence 0.6 (lower than other extractors)", () => {
    const captured = [{ patternName: "CQRS", path: "./" }]
    const { claims } = postProcessPatterns(captured, state)
    expect(claims[0].confidence).toBe(0.6)
  })
})
