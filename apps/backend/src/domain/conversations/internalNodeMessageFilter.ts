/**
 * LangGraph `streamMode: "messages"` forwards token streams from every node that
 * invokes a chat model (planner, conversation naming, agent, etc.). The UI must
 * only show the user-facing `agent` reply.
 *
 * We allowlist the visible node rather than maintaining a blocklist: a missing
 * or renamed `langgraph_node` on an internal model call would otherwise leak
 * planner JSON into the chat, or a too-aggressive blocklist could drop the agent
 * stream entirely (stuck on "Thinking…" with no answer).
 */
const USER_VISIBLE_MESSAGE_STREAM_NODE = "agent"

/**
 * Drops `messages` stream events from every LangGraph node except the
 * user-facing assistant (`agent`). Other nodes still run; their model I/O is
 * omitted from the UI message stream.
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
      if (node !== USER_VISIBLE_MESSAGE_STREAM_NODE) {
        continue
      }
    }
    yield chunk
  }
}
