/**
 * Node names whose LLM output should not appear in the streamed UI (internal only).
 * When adding new internal nodes to the conversation graph, add them here or their
 * LLM output will leak into the streamed response.
 */
const INTERNAL_MESSAGE_NODES = ["conversationNaming", "planner"] as const

type InternalNodeName = (typeof INTERNAL_MESSAGE_NODES)[number]

/**
 * Filters out "messages" stream events from internal nodes (e.g. conversationNaming, planner).
 * LangGraph emits text-start/text-delta/text-end for ALL model invocations (including
 * model.invoke()). The metadata includes langgraph_node to identify the source node.
 * We filter these so only the final agent reply is shown as streamed text.
 * Dropping whole `messages` tuples can split text-start from later deltas for the same
 * message id; `createTextStartRepairTransform` in conversationUiStreamPipeline.ts heals the UI stream.
 */
export async function* filterInternalNodeMessageChunks(
  stream: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const chunk of stream) {
    if (!Array.isArray(chunk) || chunk.length < 2) {
      yield chunk
      continue
    }
    const [mode, data] =
      chunk.length === 3 ? [chunk[1], chunk[2]] : [chunk[0], chunk[1]]
    if (mode === "messages" && Array.isArray(data) && data.length >= 2) {
      const metadata = data[1] as Record<string, unknown> | undefined
      const node = metadata?.langgraph_node
      if (
        node &&
        INTERNAL_MESSAGE_NODES.includes(node as InternalNodeName)
      ) {
        continue
      }
    }
    yield chunk
  }
}

