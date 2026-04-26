import { client } from "@/lib/api"
import type {
  AtlassianConnectorConfig,
  AtlassianConnectorStatus,
} from "../types"

export const atlassianConnectorKeys = {
  capabilities: (orgSlug: string, connectionId: string) =>
    ["org-capabilities", orgSlug, connectionId] as const,
  orgAtlassianOauth: (orgSlug: string, connectionId: string) =>
    ["org-atlassian-oauth", orgSlug, connectionId] as const,
  status: (orgSlug: string, atlassianConnectionId?: string) =>
    [
      "atlassian-connector-status",
      orgSlug,
      atlassianConnectionId ?? "default",
    ] as const,
  config: (orgSlug: string, atlassianConnectionId?: string) =>
    [
      "atlassian-connector-config",
      orgSlug,
      atlassianConnectionId ?? "default",
    ] as const,
  githubRepos: (orgSlug: string, q: string, githubConnectionId?: string) =>
    [
      "github-repos-search",
      orgSlug,
      q,
      githubConnectionId ?? "default",
    ] as const,
}

function atlassianConnectionQuery(atlassianConnectionId?: string) {
  return atlassianConnectionId
    ? ({ query: { connectionId: atlassianConnectionId } } as const)
    : ({} as const)
}

export type OrgCapabilities = { confluenceForgeInstallUrl: string | null }
export type OrgAtlassianOauthGet = {
  oauthAppSaved: boolean
  /** Public OAuth client identifier from the saved 3LO app; null if not saved or unknown. */
  atlassianOAuthClientId: string | null
  /**
   * True when the deployment has `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET`;
   * the UI should use the global Better Auth Atlassian link only (no per-connection 3LO form).
   */
  globalAtlassianOAuthConfigured: boolean
  oauthCallbackUrl: string
  atlassianCreateUrl: string
}

export async function fetchOrgCapabilities(
  orgSlug: string,
  connectionId: string,
): Promise<OrgCapabilities> {
  const q = new URLSearchParams({ connectionId })
  const res = await fetch(`/${orgSlug}/api/v1/capabilities?${q.toString()}`, {
    credentials: "include",
  })
  if (!res.ok) throw new Error("Failed to load org capabilities")
  return res.json() as Promise<OrgCapabilities>
}

export async function fetchOrgAtlassianOauth(
  orgSlug: string,
  connectionId: string,
): Promise<OrgAtlassianOauthGet> {
  const q = new URLSearchParams({ connectionId })
  const res = await fetch(
    `/${orgSlug}/api/v1/org/atlassian-oauth?${q.toString()}`,
    { credentials: "include" },
  )
  if (!res.ok) throw new Error("Failed to load org Atlassian OAuth settings")
  return res.json() as Promise<OrgAtlassianOauthGet>
}

export async function fetchAtlassianConnectorStatus(
  orgSlug: string,
  atlassianConnectionId?: string,
): Promise<AtlassianConnectorStatus> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.status.$get({
    param: { orgSlug },
    ...atlassianConnectionQuery(atlassianConnectionId),
  })
  if (!res.ok) throw new Error("Failed to fetch Atlassian connector status")
  return res.json() as Promise<AtlassianConnectorStatus>
}

/** 409 → `null` (Forge not installed yet). */
export async function fetchAtlassianConnectorConfig(
  orgSlug: string,
  atlassianConnectionId?: string,
): Promise<AtlassianConnectorConfig | null> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.config.$get({
    param: { orgSlug },
    ...atlassianConnectionQuery(atlassianConnectionId),
  })
  if (res.status === 409) return null
  if (!res.ok) throw new Error("Failed to load connector config")
  return res.json() as Promise<AtlassianConnectorConfig>
}

export async function patchAtlassianConnectorConfig(
  orgSlug: string,
  body: { spaces?: unknown; syncTarget?: unknown },
  atlassianConnectionId?: string,
): Promise<{
  accepted: true
  savedCount: number
  syncEnqueued: boolean
  workflowName?: string
}> {
  const qs = atlassianConnectionId
    ? `?${new URLSearchParams({ connectionId: atlassianConnectionId }).toString()}`
    : ""
  const res = await fetch(
    `/${orgSlug}/api/v1/connectors/atlassian/config${qs}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
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

export async function deleteAtlassianConnector(
  orgSlug: string,
  atlassianConnectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.$delete({
    param: { orgSlug },
    ...atlassianConnectionQuery(atlassianConnectionId),
  })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(errBody.error ?? "Failed to remove connector")
  }
}

export async function registerAtlassianInstallIntent(
  orgSlug: string,
): Promise<{ id: string }> {
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
  const json = (await res.json()) as { id: string }
  if (!json.id) throw new Error("Missing connection id from install response")
  return { id: json.id }
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
  githubConnectionId?: string,
): Promise<{
  repositories: GitHubRepoItem[]
  repositorySelection: string
  hasMore: boolean
}> {
  const res = await (
    client[":orgSlug"].api.v1.github.installation.repositories.$get as (arg: {
      param: { orgSlug: string }
      query: {
        q: string
        per_page: string
        connectionId?: string
      }
    }) => Promise<Response>
  )({
    param: { orgSlug },
    query: {
      q,
      per_page: "30",
      ...(githubConnectionId ? { connectionId: githubConnectionId } : {}),
    },
  })
  if (!res.ok) throw new Error("Failed to search repositories")
  return res.json() as Promise<{
    repositories: GitHubRepoItem[]
    repositorySelection: string
    hasMore: boolean
  }>
}
