import { describe, expect, it } from "vitest"
import { postProcessLibraries } from "./identifyLibraries.js"

describe("identifyLibraries post-processing", () => {
  const state = {
    repositoryId: "repo_abc",
    roots: ["./", "apps/web"],
    targetHash: "abc123",
  }

  it("produces Library objects and USES_LIBRARY claims", () => {
    const captured = [
      { name: "Prisma", path: "./", category: "ORM", evidence: "package.json" },
      { name: "Hono", path: "apps/web", category: "HTTP", evidence: "package.json" },
    ]
    const { objects, claims } = postProcessLibraries(captured, state)

    expect(objects).toHaveLength(2)

    const libObjects = objects.filter((o) => o.kind === "Library")
    expect(libObjects).toHaveLength(2)

    expect(libObjects[0]).toMatchObject({
      kind: "Library",
      deduplicationKey: "lib:repo_abc:./:Prisma",
      name: "Prisma",
      summary: "Prisma used by ./ (ORM)",
      payload: { category: "ORM" },
    })

    expect(libObjects[1]).toMatchObject({
      kind: "Library",
      deduplicationKey: "lib:repo_abc:apps/web:Hono",
      name: "Hono",
      summary: "Hono used by apps/web (HTTP)",
    })

    expect(claims).toHaveLength(2)
    expect(claims.every((c) => c.predicate === "USES_LIBRARY")).toBe(true)
    expect(claims.every((c) => c.subjectKind === "Service" && c.objectKind === "Library")).toBe(
      true,
    )
    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo_abc:./",
      objectRef: "lib:repo_abc:./:Prisma",
      predicate: "USES_LIBRARY",
      sourceId: "identifyLibraries:repo_abc:./:Prisma:abc123",
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.8,
    })
  })

  it("deduplicates by library name per root", () => {
    const captured = [
      { name: "Prisma", path: "./" },
      { name: "prisma", path: "./" },
      { name: "drizzle", path: "./" },
    ]
    const { objects, claims } = postProcessLibraries(captured, state)

    expect(objects).toHaveLength(2) // Prisma (deduped), Drizzle
    const names = objects.map((o) => o.name).sort()
    expect(names).toEqual(["Drizzle", "Prisma"])
  })

  it("normalizes library names for deduplication", () => {
    const captured = [
      { name: "drizzle-orm", path: "./" },
      { name: "Drizzle", path: "./" },
    ]
    const { objects } = postProcessLibraries(captured, state)
    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("Drizzle")
    expect(objects[0].deduplicationKey).toBe("lib:repo_abc:./:Drizzle")
  })

  it("filters by pathMatchesRoot", () => {
    const captured = [
      { name: "Express", path: "apps/api" },
      { name: "Zod", path: "packages/shared" },
    ]
    const { objects } = postProcessLibraries(captured, {
      ...state,
      roots: ["apps/api"],
    })
    expect(objects).toHaveLength(1)
    expect(objects[0].name).toBe("Express")
    expect(objects[0].deduplicationKey).toBe("lib:repo_abc:apps/api:Express")
  })

  it("produces correct output shape for objects and claims", () => {
    const captured = [{ name: "Better Auth", path: "./", category: "auth" }]
    const { objects, claims } = postProcessLibraries(captured, state)

    expect(objects[0]).toMatchObject({
      kind: "Library",
      deduplicationKey: expect.stringMatching(/^lib:repo_abc:\.\/:.*/),
      name: expect.any(String),
      summary: expect.any(String),
    })

    expect(claims[0]).toMatchObject({
      subjectRef: "svc:repo_abc:./",
      subjectKind: "Service",
      objectRef: expect.stringMatching(/^lib:repo_abc:\.\/:.*/),
      objectKind: "Library",
      predicate: "USES_LIBRARY",
      sourceId: expect.any(String),
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.8,
      provenance: expect.objectContaining({ root: "./" }),
    })
  })
})
