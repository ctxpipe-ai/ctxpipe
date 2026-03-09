import { describe, expect, it } from "vitest"
import { ClaimEvidenceSchema, ClaimSchema } from "./claims.js"
import { RetrievalPlanSchema } from "./plan.js"
import { getYamlSchemaForLlm } from "./llm-prompt.js"

describe("retrieval schema", () => {
  it("ClaimSchema parses valid claim", () => {
    const claim = {
      id: "claim_abc123",
      orgId: "org_xyz",
      subjectId: "svc_1",
      predicate: "DEPENDS_ON",
      objectId: "db_1",
      status: "active",
      firstObservedAt: new Date("2026-01-01"),
      lastObservedAt: new Date("2026-03-01"),
      aggregatedConfidence: 0.9,
    }
    expect(ClaimSchema.parse(claim)).toEqual(claim)
  })

  it("ClaimEvidenceSchema parses valid evidence", () => {
    const evidence = {
      id: "ev_abc123",
      claimId: "claim_xyz",
      sourceType: "git",
      sourceId: "repo/file.ts",
      extractionMethod: "deterministic",
      confidence: 0.95,
      observedAt: new Date("2026-03-01"),
    }
    expect(ClaimEvidenceSchema.parse(evidence)).toEqual(evidence)
  })

  it("RetrievalPlanSchema parses valid plan", () => {
    const plan = {
      steps: [
        { type: "hybrid_search" as const, params: { query: "auth" } },
        { type: "code_search" as const, params: { repositoryId: "repo_1" } },
      ],
    }
    const parsed = RetrievalPlanSchema.parse(plan)
    expect(parsed.steps).toHaveLength(2)
    expect(parsed.depthLimit).toBe(3)
    expect(parsed.resultLimit).toBe(20)
  })

  it("getYamlSchemaForLlm returns non-empty string", () => {
    const yaml = getYamlSchemaForLlm()
    expect(yaml).toBeTruthy()
    expect(yaml.length).toBeGreaterThan(100)
    expect(yaml).toContain("hybrid_search")
    expect(yaml).toContain("code_search")
  })
})
