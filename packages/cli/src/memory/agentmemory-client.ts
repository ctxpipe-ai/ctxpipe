import type { ImportPayload } from "./hydration.js"

export type AgentMemorySearchHit = {
  id: string
  type: string
  title: string
  content: string
  concepts: string[]
  files: string[]
  score?: number
}

export async function agentMemorySearch(args: {
  url: string
  secret?: string
  query: string
  project: string
  cwd: string
  limit?: number
}): Promise<AgentMemorySearchHit[]> {
  const res = await fetch(`${args.url.replace(/\/$/, "")}/agentmemory/search`, {
    method: "POST",
    headers: bearer(args.secret),
    body: JSON.stringify({
      query: args.query,
      project: args.project,
      cwd: args.cwd,
      limit: args.limit ?? 10,
    }),
  })
  if (!res.ok) {
    throw new Error(
      `AgentMemory search failed: ${res.status} ${res.statusText}`,
    )
  }
  const json = (await res.json()) as
    | { results?: AgentMemorySearchHit[]; matches?: AgentMemorySearchHit[] }
    | AgentMemorySearchHit[]
  if (Array.isArray(json)) return json
  return json.results ?? json.matches ?? []
}

export async function agentMemoryImport(args: {
  url: string
  secret?: string
  payload: ImportPayload
}): Promise<void> {
  const res = await fetch(`${args.url.replace(/\/$/, "")}/agentmemory/import`, {
    method: "POST",
    headers: bearer(args.secret),
    body: JSON.stringify(args.payload),
  })
  if (!res.ok) {
    throw new Error(
      `AgentMemory import failed: ${res.status} ${res.statusText}`,
    )
  }
}

export async function agentMemoryLiveZ(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/agentmemory/livez`, {
      signal: AbortSignal.timeout(2_000),
    })
    return res.ok
  } catch {
    return false
  }
}

function bearer(secret: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (secret) headers.authorization = `Bearer ${secret}`
  return headers
}
