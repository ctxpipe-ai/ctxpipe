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
})
