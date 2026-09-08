import { signUpstreamJwt } from "../auth/upstreamJwt.js"
import { parseEnv } from "../config/env.js"
import { capturedSourceRevision } from "../domain/codeIngestion/source-revision-context.js"
import { codesearchBaseUrl } from "../lib/agentToolRuntime.js"
import { withTransientHttpRetry } from "../lib/withTransientHttpRetry.js"
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
  repository: Pick<ZoektRepositoryRow, "id" | "orgId">,
  body: GraphRequestBody,
  workspace?: { workspaceId: string } & ({ sha: string } | { legacy: true }),
): Promise<Record<string, unknown>> {
  const source = capturedSourceRevision(repository.orgId, repository.id)
  if (source && workspace)
    throw new Error("Extraction tool cannot select a workspace projection")
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const token = await signUpstreamJwt({
    env,
    audience: env.AUTH_TOKEN_AUDIENCE_CODESEARCH ?? "codesearch",
    claims: {
      sub: `repo:${repository.id}`,
      orgId: repository.orgId,
      principal: "service",
      ...(source
        ? {
            repositoryRevisions: [
              { repositoryId: source.repositoryId, sha: source.sha },
            ],
          }
        : {}),
      ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
      ...(workspace && "legacy" in workspace
        ? { legacyWorkspace: true as const }
        : {}),
      ...(workspace && "sha" in workspace
        ? {
            workspaceRevisions: [
              { repositoryId: repository.id, sha: workspace.sha },
            ],
          }
        : {}),
    },
  })
  const res = await withTransientHttpRetry(
    async () =>
      fetch(`${codesearchBaseUrl()}/${repository.id}/graph`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }),
    { retries: 10, baseDelayMs: 200, maxDelayMs: 30_000 },
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    throw new Error(
      `codesearch graph failed with status ${res.status}${errText ? `: ${errText}` : ""}`,
    )
  }
  return (await res.json()) as Record<string, unknown>
}
