import { describe, expect, it } from "vitest"
import type { ConversationGraphState } from "../state.js"
import { collectKnowledgeGraphFocusNodeIds } from "./knowledgeGraphFocus.js"

describe("collectKnowledgeGraphFocusNodeIds", () => {
  it("collects candidate, payload, graph, and traversal node ids in order", () => {
    const state = {
      candidates: [
        {
          id: "cand_1",
          sourceChannels: ["graph"],
          objectId: "svc:vlm",
          payload: {
            nodeIds: ["api:vlm.generate", "db:media"],
          },
        },
        {
          id: "cand_2",
          sourceChannels: ["semantic"],
          payload: {
            sourceId: "svc:vlm",
            targetId: "lib:torch",
          },
        },
      ],
      graphNodes: [{ id: "infra:gpu-workers" }],
      traversalResults: [{ nodeIds: ["queue:vlm-jobs", "svc:vlm"] }],
    } satisfies Partial<ConversationGraphState>

    expect(
      collectKnowledgeGraphFocusNodeIds(
        state as unknown as ConversationGraphState,
      ),
    ).toEqual([
      "svc:vlm",
      "api:vlm.generate",
      "db:media",
      "lib:torch",
      "infra:gpu-workers",
      "queue:vlm-jobs",
    ])
  })
})
