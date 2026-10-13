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

/** `_meta` key of the machine-readable error of a failed tool call. */
export const TOOL_ERROR_META_KEY = "ai.ctxpipe/error"

/**
 * `isError: true` with `{ code, message, retryable }` as TOON text and in
 * `_meta`. Not in `structuredContent`: the MCP SDK Client checks
 * `structuredContent` against the output schema of the tool, also on errors.
 */
export function toolFailure(error: McpToolError): CallToolResult {
  const structured = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  }
  return {
    isError: true,
    content: [{ type: "text", text: encode({ error: structured }) }],
    _meta: { [TOOL_ERROR_META_KEY]: structured },
  }
}
