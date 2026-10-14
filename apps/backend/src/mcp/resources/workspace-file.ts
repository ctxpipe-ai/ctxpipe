import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { getLogger } from "../../observability/logger.js"
import {
  McpToolError,
  type McpToolErrorCode,
} from "../framework/tool-errors.js"
import { orgArgument, withCallOrg } from "../framework/tool-registry.js"
import { readFileByRef, readFileInputShape } from "../tools/read-file.js"

/**
 * The resource template for @-mention (ADR-051 §4): a ref of `read_file`
 * becomes `ctxpipe://{org}/{workspace}/{+ref}`. A resource does not reach the
 * model on its own; the user picks it in the client.
 */
export const WORKSPACE_FILE_URI_TEMPLATE = "ctxpipe://{org}/{workspace}/{+ref}"

/** Not found for the four things the URI can name: org, Workspace, repository, and file. */
const NOT_FOUND: ReadonlySet<McpToolErrorCode> = new Set([
  "org_not_found",
  "workspace_not_found",
  "repository_not_found",
  "unknown_ref",
])

const UNAVAILABLE: ReadonlySet<McpToolErrorCode> = new Set([
  "workspace_not_ready",
  "too_many_requests",
  "internal",
])

/** A resource read has no tool result, so a tool error becomes a protocol error. */
function protocolError(error: McpToolError): McpError {
  const code = NOT_FOUND.has(error.code)
    ? // The MCP specification code for "resource not found".
      -32002
    : UNAVAILABLE.has(error.code)
      ? ErrorCode.InternalError
      : ErrorCode.InvalidParams
  return new McpError(code, error.message, {
    code: error.code,
    retryable: error.retryable,
  })
}

function variable(value: string | string[] | undefined, name: string): string {
  const raw = Array.isArray(value) ? value[0] : value
  try {
    return decodeURIComponent(raw ?? "")
  } catch {
    throw new McpToolError(
      "invalid_ref",
      `The ${name} in the URI is not valid.`,
    )
  }
}

/**
 * Register the template. A read goes through `readFileByRef`, the code of
 * `read_file`: the same ref rules, the same line and size limits, and the
 * same org check. The org comes from the URI and must be in the orgs of the
 * connection; the read runs in the RLS context of that org.
 * A resource read returns the first page only; page with the `read_file` tool.
 */
export function registerWorkspaceFileResource(server: McpServer): void {
  server.registerResource(
    "workspace-file",
    new ResourceTemplate(WORKSPACE_FILE_URI_TEMPLATE, { list: undefined }),
    {
      title: "Workspace file",
      description:
        "A knowledge unit or a linked repository file of a Workspace. The path is a ref from search_knowledge, search_code, or list_files.",
    },
    async (uri, variables) => {
      try {
        const rawInput = {
          org: variable(variables.org, "org"),
          workspace: variable(variables.workspace, "workspace"),
          ref: variable(variables.ref, "ref"),
        }
        const parsed = z
          .object({ org: orgArgument, ...readFileInputShape })
          .safeParse(rawInput)
        if (!parsed.success) {
          throw new McpToolError(
            "invalid_ref",
            "The resource URI is not valid.",
          )
        }
        const { org, ...input } = parsed.data
        const file = await withCallOrg(org, async (callOrg) => {
          return readFileByRef(callOrg, input)
        })
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: file.ref.endsWith(".md")
                ? "text/markdown"
                : "text/plain",
              text: file.content,
              _meta: {
                served: file.served,
                startLine: file.startLine,
                endLine: file.endLine,
                totalLines: file.totalLines,
                nextStartLine: file.nextStartLine,
                truncated: file.truncated,
              },
            },
          ],
        }
      } catch (error) {
        if (error instanceof McpToolError) throw protocolError(error)
        getLogger().error(
          error instanceof Error ? error : new Error(String(error)),
          { step: "mcp.resource" },
        )
        throw new McpError(
          ErrorCode.InternalError,
          "ctxpipe could not read the resource. Try again.",
        )
      }
    },
  )
}
