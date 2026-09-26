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
})
