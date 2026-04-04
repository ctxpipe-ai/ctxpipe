import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import type { ZoektRepositoryRow } from "./codesearchZoekt.js"

export type GraphPrimitive =
  | "find_symbol"
  | "get_callers"
  | "get_callees"
  | "get_imports"
  | "get_type_hierarchy"
  | "get_containing_scope"
  | "trace_path"

export type GraphRequestBody = {
  primitive: GraphPrimitive
  checkoutKey?: string
  symbol?: string
  filePath?: string
  module?: string
  maxDepth?: number
  limit?: number
  endSymbol?: string
}

export async function codesearchGraphQuery(
  repository: ZoektRepositoryRow,
  body: GraphRequestBody,
): Promise<Record<string, unknown>> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${repository.id}`,
      orgId: repository.orgId,
      principal: "service",
    },
  })
  const res = await fetch(`${codesearchBaseUrl()}/${repository.id}/graph`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    throw new Error(
      `codesearch graph failed with status ${res.status}${errText ? `: ${errText}` : ""}`,
    )
  }
  return (await res.json()) as Record<string, unknown>
}
