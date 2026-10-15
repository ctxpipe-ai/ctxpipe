import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { encode } from "@toon-format/toon"
import { HARD_CAP_CHARS, measureResult } from "./budget.js"
import { McpToolError } from "./tool-errors.js"

/**
 * `structuredContent` for clients that read it, compact TOON text for the
 * model. A result over the hard cap is a tool bug: the tool must page with
 * `fitPage` and a cursor. The registry sends `response_too_large`.
 */
export function toolSuccess(
  structured: Record<string, unknown>,
): CallToolResult {
  const { text, chars } = measureResult(structured)
  if (chars > HARD_CAP_CHARS) {
    throw new McpToolError(
      "response_too_large",
      "The result is too large. Send the call again with a smaller limit or a narrower query.",
    )
  }
  return {
    content: [{ type: "text", text }],
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
