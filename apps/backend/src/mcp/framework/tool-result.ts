import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { encode } from "@toon-format/toon"
import { HARD_CAP_CHARS } from "./budget.js"
import type { McpToolError } from "./tool-errors.js"

const TRUNCATED =
  "\n[truncated: the response is over 24,000 characters. Use the cursor, a smaller limit, or a narrower call.]"

function capText(text: string): string {
  if (text.length <= HARD_CAP_CHARS) return text
  return `${text.slice(0, HARD_CAP_CHARS - TRUNCATED.length)}${TRUNCATED}`
}

/** `structuredContent` for clients that read it, compact TOON text for the model. */
export function toolSuccess(
  structured: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: capText(encode(structured)) }],
    structuredContent: structured,
  }
}

export function toolFailure(error: McpToolError): CallToolResult {
  const structured = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  }
  return {
    isError: true,
    content: [{ type: "text", text: encode({ error: structured }) }],
    structuredContent: structured,
  }
}
