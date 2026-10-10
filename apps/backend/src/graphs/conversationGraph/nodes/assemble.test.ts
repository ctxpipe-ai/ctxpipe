import { beforeEach, describe, expect, it, vi } from "vitest"

const hydrateClaimsWithEvidenceMock = vi.hoisted(() => vi.fn())

vi.mock("../../../retrieval/index.js", () => ({
  hydrateClaimsWithEvidence: hydrateClaimsWithEvidenceMock,
}))

vi.mock("../../../models/repositories.js", () => ({
  listRepositoriesForOrg: vi.fn(async () => []),
  deriveRepositoryIndexingStatus: vi.fn(() => "ready"),
}))

import { listRepositoriesForOrg } from "../../../models/repositories.js"
import type { ConversationGraphState } from "../state.js"
import { assembleNode } from "./assemble.js"

describe("assembleNode claim hydration", () => {
  beforeEach(() => {
    hydrateClaimsWithEvidenceMock.mockReset()
    hydrateClaimsWithEvidenceMock.mockResolvedValue([])
  })

  it("shows the evidence for graph facts even when code hits fill the top candidates", async () => {
    const codeHits = Array.from({ length: 25 }, (_, i) => ({
      id: `cand_code_${i}`,
      sourceChannels: ["code" as const],
      objectId: `file:repo_1:src/f${i}.ts`,
      score: 500 - i,
      payload: {},
    }))
    const traversalHit = {
      id: "cand_trav_adr_queue",
      sourceChannels: ["graph" as const],
      objectId: "adr_queue",
      payload: { fromTraversal: true, kind: "Decision" },
    }
    const state = {
      orgId: "org_1",
      query: "why does billing use SQS?",
      candidates: [...codeHits, traversalHit],
      claimIds: ["clm_adr_influences", "clm_team_owns"],
    } as unknown as ConversationGraphState

    await assembleNode(state)

    expect(hydrateClaimsWithEvidenceMock).toHaveBeenCalledWith(
      "org_1",
      expect.arrayContaining(["clm_adr_influences", "clm_team_owns"]),
    )
  })

  it("gives one compact row per claim: the fact, its confidence, how it was sourced, and where to cite", async () => {
    const rawSourceId = `decision:repo_1:${"x".repeat(160)}:INFLUENCES:./:abc123`
    const evidence = (sourceType: string, extractionMethod: string) => ({
      id: `ev_${sourceType}`,
      claimId: "clm_adr",
      sourceType,
      sourceId: rawSourceId,
      sourceUrl: null,
      extractionMethod,
      confidence: 0.9,
      observedAt: new Date("2026-09-20T00:00:00.000Z"),
      validFrom: null,
      validTo: null,
      provenance: { path: "docs/adr/0041-use-sqs.md" },
    })
    hydrateClaimsWithEvidenceMock.mockResolvedValue([
      {
        id: "clm_adr",
        orgId: "org_1",
        subjectId: "obj_adr",
        predicate: "INFLUENCES",
        objectId: "obj_billing",
        status: "active",
        validFrom: null,
        validTo: null,
        firstObservedAt: new Date("2026-09-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-09-20T00:00:00.000Z"),
        aggregatedConfidence: 0.9,
        evidence: [evidence("git", "deterministic"), evidence("slack", "llm")],
      },
    ])
    const state = {
      orgId: "org_1",
      query: "why does billing use SQS?",
      candidates: [],
      claimIds: ["clm_adr"],
    } as unknown as ConversationGraphState

    const { retrievalContext = "" } = await assembleNode(state)

    expect(retrievalContext).toContain("docs/adr/0041-use-sqs.md")
    expect(retrievalContext).toContain("git/deterministic")
    expect(retrievalContext).toContain("slack/llm")
    expect(retrievalContext).not.toContain(rawSourceId)
    expect(retrievalContext).not.toContain("org_1")
  })

  it("names both ends of a claim by kind and name, and cites a path with its repository", async () => {
    vi.mocked(listRepositoriesForOrg).mockResolvedValueOnce([
      { id: "repo_ctx", name: "acme/context", orgId: "org_1" },
      { id: "repo_api", name: "acme/api", orgId: "org_1" },
    ] as Awaited<ReturnType<typeof listRepositoriesForOrg>>)
    hydrateClaimsWithEvidenceMock.mockResolvedValue([
      {
        id: "clm_pr",
        orgId: "org_1",
        subjectId: "obj_pr",
        predicate: "ADDED",
        objectId: "obj_unknown",
        status: "active",
        validFrom: new Date("2026-03-04T00:00:00.000Z"),
        validTo: null,
        firstObservedAt: new Date("2026-09-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-09-20T00:00:00.000Z"),
        aggregatedConfidence: 0.95,
        evidence: [
          {
            id: "ev_1",
            claimId: "clm_pr",
            sourceType: "git",
            sourceId:
              "githubPull:repo_ctx:repo_api:github/pulls/acme/api/41.md:ADDED:docs/adr/0007.md:abc123",
            sourceUrl: null,
            extractionMethod: "deterministic",
            confidence: 0.95,
            observedAt: new Date("2026-09-20T00:00:00.000Z"),
            validFrom: null,
            validTo: null,
            provenance: { path: "github/pulls/acme/api/41.md" },
          },
        ],
      },
    ])
    const state = {
      orgId: "org_1",
      query: "why does billing use a queue?",
      candidates: [
        {
          id: "cand_trav_obj_pr",
          sourceChannels: ["graph" as const],
          objectId: "obj_pr",
          payload: {
            fromTraversal: true,
            kind: "PullRequest",
            name: "acme/api#41",
          },
        },
      ],
      claimIds: ["clm_pr"],
    } as unknown as ConversationGraphState

    const { retrievalContext = "" } = await assembleNode(state)
    const claims = retrievalContext.slice(
      retrievalContext.indexOf("Claims with evidence"),
      retrievalContext.indexOf("Repositories (TOON)"),
    )

    expect(claims).toContain("PullRequest acme/api#41")
    expect(claims).not.toContain("obj_pr")
    expect(claims).toContain("obj_unknown")
    expect(claims).toContain("acme/context:github/pulls/acme/api/41.md")
  })
})
