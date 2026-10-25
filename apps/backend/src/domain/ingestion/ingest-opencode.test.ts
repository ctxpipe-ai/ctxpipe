import { describe, expect, it } from "vitest"

import { ingestOpenCodeConfig } from "./ingest-opencode.js"

describe("ingest OpenCode config", () => {
  it("adds the tool bridge as the tanstack MCP server, with the firewall placeholder as its token", () => {
    const config = ingestOpenCodeConfig({
      modelBase: "medium-model",
      models: ["fast-model"],
      skills: ["discover-roots"],
      proxyAddsCredentials: true,
      toolBridgeUrl:
        "http://api.internal:3000/api/v1/workspace-ingest/tool-bridge",
    })
    expect(config.mcp).toEqual({
      tanstack: {
        type: "remote",
        url: "http://api.internal:3000/api/v1/workspace-ingest/tool-bridge",
        enabled: true,
        headers: { Authorization: "Bearer ctxpipe-firewall" },
      },
    })
    expect(Object.keys(config.provider.ctxpipe.models).sort()).toEqual([
      "fast-model",
      "medium-model",
    ])
    expect(config.model).toBe("ctxpipe/medium-model")
  })
})
