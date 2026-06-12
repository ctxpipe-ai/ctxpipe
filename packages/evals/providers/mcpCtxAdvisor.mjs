import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

function extractToolText(result) {
  if (!result?.content || !Array.isArray(result.content)) return ""
  const parts = []
  for (const c of result.content) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text)
  }
  return parts.join("\n")
}

/**
 * Calls ctxpipe MCP tool `ctx_advisor` over streamable HTTP (same surface as Cursor MCP).
 */
export default class McpCtxAdvisorProvider {
  id = () => "ctxpipe-mcp-ctx-advisor"

  /**
   * @param {string} prompt
   * @param {object} context
   */
  callApi = async (prompt, context) => {
    const mcpUrl = process.env.CTXPIPE_MCP_URL
    const token = process.env.CTXPIPE_API_TOKEN
    if (!mcpUrl || !token) {
      return {
        error:
          "CTXPIPE_MCP_URL and CTXPIPE_API_TOKEN must be set for the MCP provider",
      }
    }

    const vars = context?.vars ?? {}
    const userPrompt = vars.question ?? prompt

    const client = new Client({
      name: "ctxpipe-evals",
      version: "0.1.0",
    })

    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    })

    try {
      await client.connect(transport)
      const args = { prompt: userPrompt }
      if (vars.current_project_name != null) {
        args.currentProjectName = String(vars.current_project_name)
      }
      if (vars.conversation_id != null) {
        args.conversationId = String(vars.conversation_id)
      }
      const result = await client.callTool({
        name: "ctx_advisor",
        arguments: args,
      })
      return { output: extractToolText(result) }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      return { error: err }
    } finally {
      try {
        await transport.close()
      } catch {
        /* ignore */
      }
    }
  }
}
