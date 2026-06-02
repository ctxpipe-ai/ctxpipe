import { resolveCtxpipeBaseUrl } from "../auth.js"
import { startMcpServer } from "./mcp-server.js"

export async function runMemoryMcp(opts: { baseUrl: string }): Promise<void> {
  const baseUrl = resolveCtxpipeBaseUrl(process.cwd(), opts.baseUrl)
  await startMcpServer({ baseUrl })
}
