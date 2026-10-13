import { describe, expect, it } from "vitest"
import { mergeCandidates } from "./candidateMerge.js"

describe("mergeCandidates", () => {
  it("tells the model what each walked node is instead of repeating claim ids", () => {
    const candidates = mergeCandidates(
      [],
      [],
      [],
      [
        {
          nodeIds: ["obj_billing", "obj_adr"],
          nodes: [
            {
              id: "obj_adr",
              kind: "Decision",
              name: "Use SQS for billing events",
              status: "accepted",
              summary: null,
            },
          ],
        },
      ],
    )

    expect(candidates.find((c) => c.objectId === "obj_adr")?.payload).toEqual({
      fromTraversal: true,
      kind: "Decision",
      name: "Use SQS for billing events",
      status: "accepted",
    })
    expect(
      candidates.find((c) => c.objectId === "obj_billing")?.payload,
    ).toEqual({ fromTraversal: true })
  })

  it("gives a walked pull request its title, because its name is only owner/repo#N", () => {
    const candidates = mergeCandidates(
      [],
      [],
      [],
      [
        {
          nodeIds: ["obj_pr"],
          nodes: [
            {
              id: "obj_pr",
              kind: "PullRequest",
              name: "acme/billing#41",
              status: null,
              summary: "Move billing events from RabbitMQ to SQS",
            },
          ],
        },
      ],
    )

    expect(candidates[0]?.payload).toEqual({
      fromTraversal: true,
      kind: "PullRequest",
      name: "acme/billing#41",
      summary: "Move billing events from RabbitMQ to SQS",
    })
  })
})
