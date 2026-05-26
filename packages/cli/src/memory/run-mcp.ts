import { startMcpServer } from "./mcp-server.js"

export async function runMemoryMcp(opts: { baseUrl: string }): Promise<void> {
  await startMcpServer({ baseUrl: opts.baseUrl })
}
