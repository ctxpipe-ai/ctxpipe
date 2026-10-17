export type McpToolResult = {
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
}

/** Parse a Streamable HTTP MCP `tools/call` body (JSON or SSE). */
export function mcpToolResult(body: string): McpToolResult {
  const payloads: unknown[] = []
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) {
    payloads.push(JSON.parse(trimmed))
  } else {
    for (const line of body.split("\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!data.startsWith("{")) continue
      payloads.push(JSON.parse(data))
    }
  }
  for (const payload of payloads) {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("result" in payload) ||
      typeof payload.result !== "object" ||
      payload.result === null
    ) {
      continue
    }
    return payload.result as McpToolResult
  }
  throw new Error("MCP response did not include a tool result")
}

export function mcpToolText(result: McpToolResult): string {
  return result.content?.find((part) => part.type === "text")?.text ?? ""
}
