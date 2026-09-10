/** Mirrors `apps/backend/src/models/github-mcp-config-pr.ts` merge logic for onboarding preview only. */

export function mcpStreamUrlForOrg(
  mcpBaseUrl: string,
  orgSlug: string,
): string {
  const base = mcpBaseUrl.replace(/\/$/, "")
  const q = new URLSearchParams({ orgSlug })
  return `${base}/mcp?${q.toString()}`
}

function ctxpipeMcpServerEntry(mcpUrl: string): Record<string, unknown> {
  return {
    type: "streamable-http",
    url: mcpUrl,
  }
}

export function buildOrMergeCursorClaudeMcpJson(
  existingUtf8: string | null,
  mcpUrl: string,
): string {
  const entry = ctxpipeMcpServerEntry(mcpUrl)
  if (existingUtf8) {
    try {
      const parsed = JSON.parse(existingUtf8) as unknown
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "mcpServers" in parsed &&
        typeof (parsed as { mcpServers?: unknown }).mcpServers === "object" &&
        (parsed as { mcpServers?: unknown }).mcpServers !== null &&
        !Array.isArray((parsed as { mcpServers: unknown }).mcpServers)
      ) {
        const prev = parsed as {
          mcpServers: Record<string, unknown>
          [key: string]: unknown
        }
        const merged = {
          ...prev,
          mcpServers: {
            ...prev.mcpServers,
            ctxpipe: entry,
          },
        }
        return `${JSON.stringify(merged, null, 2)}\n`
      }
    } catch {
      // fall through
    }
  }
  return `${JSON.stringify({ mcpServers: { ctxpipe: entry } }, null, 2)}\n`
}

export function buildOrMergeOpenCodeMcpJson(
  existingUtf8: string | null,
  mcpUrl: string,
): string {
  const entry = {
    type: "remote",
    url: mcpUrl,
    enabled: true,
  }
  if (existingUtf8) {
    try {
      const parsed = JSON.parse(existingUtf8) as unknown
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "mcp" in parsed &&
        typeof (parsed as { mcp?: unknown }).mcp === "object" &&
        (parsed as { mcp?: unknown }).mcp !== null &&
        !Array.isArray((parsed as { mcp: unknown }).mcp)
      ) {
        const prev = parsed as {
          mcp: Record<string, unknown>
          [key: string]: unknown
        }
        const merged = {
          ...prev,
          mcp: {
            ...prev.mcp,
            ctxpipe: entry,
          },
        }
        return `${JSON.stringify(merged, null, 2)}\n`
      }
    } catch {
      // fall through
    }
  }
  return `${JSON.stringify({ mcp: { ctxpipe: entry } }, null, 2)}\n`
}

export function pathsForAgent(
  agent: "cursor" | "claude_code" | "opencode",
): string[] {
  switch (agent) {
    case "cursor":
      return [".cursor/mcp.json"]
    case "claude_code":
      return [".mcp.json"]
    case "opencode":
      return ["opencode.json"]
    default: {
      const _e: never = agent
      return _e
    }
  }
}
