import { beforeEach, describe, expect, it, vi } from "vitest"

const hydrateClaimsWithEvidenceMock = vi.hoisted(() => vi.fn())

vi.mock("../../../retrieval/index.js", () => ({
  hydrateClaimsWithEvidence: hydrateClaimsWithEvidenceMock,
}))

vi.mock("../../../models/repositories.js", () => ({
  listRepositoriesForOrg: vi.fn(async () => []),
  deriveRepositoryIndexingStatus: vi.fn(() => "ready"),
}))

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
})
