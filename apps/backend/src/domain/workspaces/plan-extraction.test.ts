import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { linkPackageHierarchy } from "../../graphs/codeIngestionGraph/nodes/linkLocatedPaths.js"
import { ownershipMigrationFiles } from "../ingestion/ownership-migration.js"
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

  it("retracts the open legacy claims of a migrated file in a full retraction and keeps the closed ones", async () => {
    const repositoryUrl = "https://github.com/example-org/billing"
    const workspaceRepositoryUrl = "https://github.com/example-org/context"
    const path = "knowledge/services/billing.md"
    const [migrated] = ownershipMigrationFiles({
      workspaceRepositoryUrl,
      sourcePaths: new Map([
        [repositoryUrl, "sources/github/example-org/billing.md"],
      ]),
      files: [
        {
          path,
          content: [
            "---",
            "kind: Service",
            "generated_by: ctxpipe",
            `source: ${repositoryUrl}#src/index.ts`,
            "claims:",
            "  - to: ./ledger.md",
            "    predicate: CALLS",
            "    confidence: 0.9",
            `    source: ${repositoryUrl}#src/ledger-client.ts`,
            "  - to: ./old.md",
            "    predicate: CALLS",
            "    confidence: 0.7",
            `    source: ${repositoryUrl}#src/old-client.ts`,
            "    valid_from: 2025-01-01T00:00:00.000Z",
            "    valid_to: 2026-01-01T00:00:00.000Z",
            "---",
            "",
            "# Billing",
            "",
          ].join("\n"),
        },
      ],
    })
    if (!migrated) throw new Error("The migration did not move the file")
    const observedAt = "2026-10-01T00:00:00.000Z"

    const plan = await planCapturedExtraction({
      extraction: capturedExtractionSchema.parse({
        repositoryId: "repo_billing",
        repositoryUrl,
        sourceSha: "b".repeat(40),
        retraction: { mode: "full", observedAt },
        objects: [],
        claims: [],
      }),
      workspaceId: "ws_context",
      workspaceRepositoryUrl,
      existingKnowledge: [migrated],
      knownKnowledgePaths: {},
      stampImportKey: false,
    })

    const file = plan.files.find((f) => f.path === path)
    const claims = (
      parse(file?.content.split("---")[1] ?? "") as { claims: unknown[] }
    ).claims
    expect(claims).toEqual([
      {
        to: "./ledger.md",
        predicate: "CALLS",
        confidence: 0.9,
        source: `${repositoryUrl}#src/ledger-client.ts`,
        evidence: { kind: "legacy" },
        valid_to: observedAt,
      },
      {
        to: "./old.md",
        predicate: "CALLS",
        confidence: 0.7,
        source: `${repositoryUrl}#src/old-client.ts`,
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_to: "2026-01-01T00:00:00.000Z",
        evidence: { kind: "legacy" },
      },
    ])
  })
})
