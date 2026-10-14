import { client } from "@/lib/api"
import { apiFetch, readApiJson } from "@/lib/api-result"
import type { AtlassianConnectorStatus } from "../types"

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
  /** Prefix to invalidate every Forge row’s status for an org (e.g. after account link claim). */
  allStatusForOrg: (orgSlug: string) =>
    ["atlassian-connector-status", orgSlug] as const,
  githubRepos: (orgSlug: string, q: string, githubConnectionId?: string) =>
    [
      "github-repos-search",
      orgSlug,
      q,
      githubConnectionId ?? "default",
    ] as const,
  forgeProvisionStatus: (orgSlug: string, connectionId: string) =>
    ["forge-provision-status", orgSlug, connectionId] as const,
}

function atlassianConnectionQuery(atlassianConnectionId?: string) {
  return atlassianConnectionId
    ? ({ query: { connectionId: atlassianConnectionId } } as const)
    : ({ query: {} } as const)
}

export type OrgCapabilities = { confluenceForgeInstallUrl: string | null }

export type OrgAtlassianOauthGet = {
  oauthAppSaved: boolean
  atlassianOAuthClientId: string | null
  globalAtlassianOAuthConfigured: boolean
  oauthCallbackUrl: string
  atlassianCreateUrl: string
}

export async function fetchOrgCapabilities(
  orgSlug: string,
  connectionId: string,
): Promise<OrgCapabilities> {
  const q = new URLSearchParams({ connectionId })
  const res = await apiFetch(
    `/${orgSlug}/api/v1/capabilities?${q.toString()}`,
    {
      credentials: "include",
    },
  )
  return readApiJson<OrgCapabilities>(res, {
    message: "Failed to load org capabilities",
  })
}

export async function fetchOrgAtlassianOauth(
  orgSlug: string,
  connectionId: string,
): Promise<OrgAtlassianOauthGet> {
  const q = new URLSearchParams({ connectionId })
  const res = await apiFetch(
    `/${orgSlug}/api/v1/org/atlassian-oauth?${q.toString()}`,
    { credentials: "include" },
  )
  return readApiJson<OrgAtlassianOauthGet>(res, {
    message: "Failed to load org Atlassian OAuth settings",
  })
}

export async function fetchAtlassianConnectorStatus(
  orgSlug: string,
  atlassianConnectionId?: string,
): Promise<AtlassianConnectorStatus> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.status.$get({
    param: { orgSlug },
    ...atlassianConnectionQuery(atlassianConnectionId),
  })
  return readApiJson<AtlassianConnectorStatus>(res, {
    message: "Failed to fetch Atlassian connector status",
  })
}

export async function deleteAtlassianConnector(
  orgSlug: string,
  atlassianConnectionId?: string,
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.$delete({
    param: { orgSlug },
    ...atlassianConnectionQuery(atlassianConnectionId),
  })
  await readApiJson<void>(res, { message: "Failed to remove connector" })
}

export type ForgeProvisionStatusPayload = {
  connectionId: string
  provisionStatus: "idle" | "running" | "succeeded" | "failed"
  provisionErrorCode: string | null
  userMessage: string | null
}

export async function fetchForgeProvisionStatus(
  orgSlug: string,
  connectionId: string,
): Promise<ForgeProvisionStatusPayload> {
  const q = new URLSearchParams({ connectionId })
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/atlassian/provision-status?${q.toString()}`,
    { credentials: "include" },
  )
  return readApiJson<ForgeProvisionStatusPayload>(res, {
    message: "Failed to load Forge provision status",
  })
}

export type ForgeProvisionRequestBody = {
  connectionId: string
  confluenceSiteHost: string
  forgeScopedApiToken: string
  forgeOperatorEmail: string
  confluenceForgeInstallUrl?: string
}

export async function postForgeProvision(
  orgSlug: string,
  body: ForgeProvisionRequestBody,
): Promise<{ accepted: true; workflowName?: string }> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/connectors/atlassian/provision`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  return readApiJson<{ accepted: true; workflowName?: string }>(res, {
    message: "Failed to start Forge provisioning",
  })
}

export async function registerAtlassianInstallIntent(
  orgSlug: string,
  options: {
    /** The user opens the Forge install: a cancel then keeps the draft. */
    installOpened?: boolean
  } = {},
): Promise<{ id: string }> {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.atlassian.installation.$post({
    param: { orgSlug },
    query: options.installOpened ? { installOpened: "true" } : {},
  })
  const json = await readApiJson<{ id: string }>(res, {
    message: "Failed to register install intent",
  })
  if (!json.id) throw new Error("Missing connection id from install response")
  return { id: json.id }
}

/**
 * Cancel a setup: the server deletes the pending connection only while it is
 * empty. A 409 means the setup has progress, so it stays.
 */
export async function cancelAtlassianSetup(
  orgSlug: string,
  atlassianConnectionId: string,
): Promise<void> {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.atlassian.installation.$delete({
    param: { orgSlug },
    query: { connectionId: atlassianConnectionId },
  })
  await readApiJson<void>(res, {
    emptyOn: [409],
    message: "Failed to cancel the Confluence setup",
  })
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
  manageUrl: string | null
  hasMore: boolean
  warning?: string
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
  return readApiJson(res, { message: "Failed to search repositories" })
}
