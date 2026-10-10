import { describe, expect, it } from "vitest"
import { linkPackageHierarchy } from "../../graphs/codeIngestionGraph/nodes/linkLocatedPaths.js"
import { capturedExtractionSchema } from "./extraction.js"
import { planCapturedExtraction } from "./plan-extraction.js"

describe("planCapturedExtraction", () => {
  it("writes package hierarchy claims to the package and repository files", async () => {
    const repositoryId = "repo_app"
    const repositoryUrl = "https://github.com/acme/app.git"
    const objects = [
      { kind: "Service" as const, deduplicationKey: `svc:${repositoryId}:./` },
      {
        kind: "App" as const,
        deduplicationKey: `app:${repositoryId}:packages/web`,
      },
    ]
    const claims = linkPackageHierarchy({
      repositoryId,
      targetHash: "a".repeat(40),
      objects,
      claims: [],
    })
    expect(claims.map((claim) => claim.predicate).sort()).toEqual([
      "IMPLEMENTED_IN",
      "PART_OF",
    ])

    const plan = await planCapturedExtraction({
      extraction: capturedExtractionSchema.parse({
        repositoryId,
        repositoryUrl,
        sourceSha: "a".repeat(40),
        objects,
        claims: claims.map((claim) => ({
          subjectRef: claim.subjectRef,
          objectRef: claim.objectRef,
          predicate: claim.predicate,
          confidence: claim.confidence,
          sourceId: claim.sourceId,
        })),
      }),
      workspaceId: "ws_app",
      workspaceRepositoryUrl: repositoryUrl,
      existingKnowledge: [{ path: "AGENTS.md", content: "# App\n" }],
      knownKnowledgePaths: {},
      stampImportKey: false,
    })

    const written = plan.files
      .filter((file) => file.path.startsWith("knowledge/"))
      .map((file) => file.content)
      .join("\n")
    expect(written).toMatch(/predicate: PART_OF/)
    expect(written).toMatch(/predicate: IMPLEMENTED_IN/)
    expect(written).toMatch(/to: (\.\.\/)+AGENTS\.md/)
  })
})
