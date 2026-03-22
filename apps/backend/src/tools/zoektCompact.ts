/** Default Zoekt caps for full/raw responses. */
export const FULL_SEARCH_OPTS: Record<string, unknown> = {
  ShardMaxMatchCount: 200,
  TotalMaxMatchCount: 800,
  MaxDocDisplayCount: 80,
  MaxMatchDisplayCount: 400,
}

/** Tighter caps when returning compact matches only. */
export const COMPACT_SEARCH_OPTS: Record<string, unknown> = {
  ShardMaxMatchCount: 80,
  TotalMaxMatchCount: 200,
  MaxDocDisplayCount: 40,
  MaxMatchDisplayCount: 120,
}

export const COMPACT_MAX_MATCHES = 80
export const COMPACT_SNIPPET_CHARS = 220

type ZoektLineMatch = {
  LineNumber?: number
  Line?: string
  Preview?: string
}

type ZoektFileMatch = {
  FileName?: string
  LineMatches?: ZoektLineMatch[]
}

function getZoektFiles(raw: Record<string, unknown>): ZoektFileMatch[] {
  const direct = raw.Files
  if (Array.isArray(direct)) return direct as ZoektFileMatch[]
  const result = raw.Result as Record<string, unknown> | undefined
  const nested = result?.Files
  if (Array.isArray(nested)) return nested as ZoektFileMatch[]
  return []
}

function decodeZoektLine(line: string | undefined): string {
  if (!line) return ""
  try {
    return Buffer.from(line, "base64").toString("utf-8")
  } catch {
    return line
  }
}

export function compactSearchResponse(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const files = getZoektFiles(raw)
  const matches: Array<{
    path: string
    line?: number
    snippet: string
  }> = []
  for (const f of files) {
    const path = f.FileName ?? ""
    const lines = Array.isArray(f.LineMatches) ? f.LineMatches : []
    for (const lm of lines) {
      if (matches.length >= COMPACT_MAX_MATCHES) break
      const rawLine = lm.Line ?? lm.Preview
      const decoded = decodeZoektLine(rawLine).slice(0, COMPACT_SNIPPET_CHARS)
      matches.push({
        path,
        line: typeof lm.LineNumber === "number" ? lm.LineNumber : undefined,
        snippet: decoded,
      })
    }
    if (matches.length >= COMPACT_MAX_MATCHES) break
  }
  return {
    format: "compact",
    matchCount: matches.length,
    truncated: matches.length >= COMPACT_MAX_MATCHES,
    matches,
  }
}
