import { describe, expect, it } from "vitest"
import { filterInternalNodeMessageChunks } from "./internalNodeMessageFilter.js"

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe("filterInternalNodeMessageChunks", () => {
  it("drops messages chunks from planner, keeps agent", async () => {
    const plannerChunk = [
      "messages",
      [{}, { langgraph_node: "planner", langgraph_step: 1 }],
    ]
    const agentChunk = [
      "messages",
      [{}, { langgraph_node: "agent", langgraph_step: 2 }],
    ]
    const customChunk = ["custom", { type: "rename", name: "x" }]

    const out = await collect(
      filterInternalNodeMessageChunks(
        (async function* () {
          yield plannerChunk
          yield agentChunk
          yield customChunk
        })(),
      ),
    )

    expect(out).toEqual([agentChunk, customChunk])
  })

  it("drops messages chunks when langgraph_node is missing", async () => {
    const chunk = ["messages", [{}, {}]]
    const out = await collect(
      filterInternalNodeMessageChunks(
        (async function* () {
          yield chunk
        })(),
      ),
    )
    expect(out).toEqual([])
  })
})
