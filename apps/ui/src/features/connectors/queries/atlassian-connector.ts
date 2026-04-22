import { client } from "@/lib/api"
import type {
  AtlassianConnectorConfig,
  AtlassianConnectorStatus,
} from "../types"

export const atlassianConnectorKeys = {
  status: (orgSlug: string) => ["atlassian-connector-status", orgSlug] as const,
  config: (orgSlug: string) => ["atlassian-connector-config", orgSlug] as const,
  githubRepos: (orgSlug: string, q: string) =>
    ["github-repos-search", orgSlug, q] as const,
}

export async function fetchAtlassianConnectorStatus(
  orgSlug: string,
): Promise<AtlassianConnectorStatus> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.status.$get({
    param: { orgSlug },
  })
  if (!res.ok) throw new Error("Failed to fetch Atlassian connector status")
  return res.json() as Promise<AtlassianConnectorStatus>
}

/** 409 → `null` (Forge not installed yet). */
export async function fetchAtlassianConnectorConfig(
  orgSlug: string,
): Promise<AtlassianConnectorConfig | null> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.config.$get({
    param: { orgSlug },
  })
  if (res.status === 409) return null
  if (!res.ok) throw new Error("Failed to load connector config")
  return res.json() as Promise<AtlassianConnectorConfig>
}

export async function patchAtlassianConnectorConfig(
  orgSlug: string,
  body: { spaces?: unknown; syncTarget?: unknown },
): Promise<{
  accepted: true
  savedCount: number
  syncEnqueued: boolean
  workflowName?: string
}> {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.atlassian.config.$patch({
    param: { orgSlug },
    json: body as never,
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? "Failed to save connector config")
  }
  return res.json() as Promise<{
    accepted: true
    savedCount: number
    syncEnqueued: boolean
    workflowName?: string
  }>
}

export async function deleteAtlassianConnector(orgSlug: string): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.$delete({
    param: { orgSlug },
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? "Failed to remove connector")
  }
}

export async function registerAtlassianInstallIntent(
  orgSlug: string,
): Promise<void> {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.atlassian.installation.$post({
    param: { orgSlug },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string
      error?: string
    }
    throw new Error(
      body.message ?? body.error ?? "Failed to register install intent",
    )
  }
}

type GitHubRepoItem = {
  id: number
  full_name: string
  html_url: string
  clone_url: string
  name: string
  default_branch: string
}

export async function searchGithubInstallationRepos(
  orgSlug: string,
  q: string,
): Promise<{
  repositories: GitHubRepoItem[]
  repositorySelection: string
  hasMore: boolean
}> {
  const res = await (
    client[":orgSlug"].api.v1.github.installation.repositories.$get as (arg: {
      param: { orgSlug: string }
      query: { q: string; per_page: string }
    }) => Promise<Response>
  )({
    param: { orgSlug },
    query: { q, per_page: "30" },
  })
  if (!res.ok) throw new Error("Failed to search repositories")
  return res.json() as Promise<{
    repositories: GitHubRepoItem[]
    repositorySelection: string
    hasMore: boolean
  }>
}
