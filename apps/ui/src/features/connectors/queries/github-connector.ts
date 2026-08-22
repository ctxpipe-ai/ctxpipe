import { queryOptions } from "@tanstack/react-query"
import { client } from "@/lib/api"
import { apiFetch, readApiJson } from "@/lib/api-result"
import { fetchOrgConnections } from "./org-connections"

export const githubConnectorKeys = {
  bootstrap: (orgSlug: string) =>
    ["github-connector-bootstrap", orgSlug] as const,
  installation: (orgSlug: string, connectionId?: string) =>
    ["github-installation", orgSlug, connectionId ?? "default"] as const,
  connectorStatus: (orgSlug: string, connectionId: string) =>
    ["github-connector-status", orgSlug, connectionId] as const,
  /** Prefix: invalidate all per-org github installation queries */
  allInstallationForOrg: (orgSlug: string) =>
    ["github-installation", orgSlug] as const,
}

export async function fetchGithubConnectorBootstrap(orgSlug: string): Promise<{
  publicApiOrigin: string
  suggestedWebhookUrlTemplate: string
  githubAppConfiguredInEnv: boolean
  rowsNeedingSecrets: number
  hostedDefaultAppInstallUrl: string | null
}> {
  const res = await client[":orgSlug"].api.v1.github.installation[
    "connector-bootstrap"
  ].$get({
    param: { orgSlug },
  })
  return readApiJson(res, {
    message: "Failed to load GitHub connector bootstrap",
  })
}

export type GithubConnectorBootstrap = Awaited<
  ReturnType<typeof fetchGithubConnectorBootstrap>
>

export function githubInstallationIsLinked(
  installation: unknown,
): installation is { installationId: number } {
  if (typeof installation !== "object" || installation === null) return false
  const id = (installation as { installationId?: unknown }).installationId
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
}

export function githubSetupLinkStateFromSummaries(
  summaries: ReadonlyArray<{ installationId: number | null } | null>,
): "linked" | "unlinked" {
  return summaries.some((summary) => githubInstallationIsLinked(summary))
    ? "linked"
    : "unlinked"
}

export function isAmbiguousGithubConnectionsError(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string" &&
    (body as { error: string }).error.includes("specify connectionId")
  )
}

export function githubInstallationOptions(
  orgSlug: string,
  connectionId?: string,
) {
  return queryOptions({
    queryKey: githubConnectorKeys.installation(orgSlug, connectionId),
    queryFn: () => fetchGithubInstallationSummary(orgSlug, connectionId),
  })
}

export async function fetchGithubInstallationSummary(
  orgSlug: string,
  connectionId?: string,
): Promise<{
  id: string
  appSlug: string | null
  accountSlug: string | null
  installationId: number | null
} | null> {
  const query = connectionId
    ? `?${new URLSearchParams({ connectionId }).toString()}`
    : ""
  const res = await apiFetch(`/${orgSlug}/api/v1/github/installation${query}`, {
    credentials: "include",
  })
  return readApiJson(res, { message: "Failed to check GitHub installation" })
}

export async function fetchGithubSetupLinkState(
  orgSlug: string,
): Promise<"linked" | "unlinked"> {
  const res = await apiFetch(`/${orgSlug}/api/v1/github/installation`, {
    credentials: "include",
  })
  if (res.status === 400) {
    const body: unknown = await res.json().catch(() => ({}))
    if (!isAmbiguousGithubConnectionsError(body)) {
      throw new Error("Failed to check GitHub installation")
    }
    const githubIds = (await fetchOrgConnections(orgSlug))
      .filter((connection) => connection.type === "github")
      .map((connection) => connection.id)
    const summaries = await Promise.all(
      githubIds.map((connectionId) =>
        fetchGithubInstallationSummary(orgSlug, connectionId),
      ),
    )
    return githubSetupLinkStateFromSummaries(summaries)
  }
  const data = await readApiJson<{ installationId: number | null } | null>(
    res,
    { message: "Failed to check GitHub installation" },
  )
  return githubSetupLinkStateFromSummaries([data])
}

export type CreateGithubDraftBody = {
  githubAppId: string
  appSlug: string
  privateKey: string
  webhookSecret: string
}

export async function createGithubDraftConnection(
  orgSlug: string,
  body: CreateGithubDraftBody,
): Promise<{ id: string }> {
  const res = await client[":orgSlug"].api.v1.github.installation.draft.$post({
    param: { orgSlug },
    json: body,
  })
  return readApiJson<{ id: string }>(res, {
    message: "Failed to save connector",
  })
}

export async function createGithubDraftPlaceholder(orgSlug: string): Promise<{
  id: string
  webhookUrl: string
}> {
  const res = await apiFetch(
    `/${orgSlug}/api/v1/github/installation/draft/placeholder`,
    { method: "POST", credentials: "include" },
  )
  return readApiJson<{ id: string; webhookUrl: string }>(res, {
    message: "Failed to reserve connector",
  })
}

export async function patchGithubDraftConnection(
  orgSlug: string,
  body: CreateGithubDraftBody & { connectionId: string },
): Promise<{ id: string }> {
  const res = await apiFetch(`/${orgSlug}/api/v1/github/installation/draft`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return readApiJson<{ id: string }>(res, {
    message: "Failed to save connector",
  })
}

export type GithubConnectorStatus = Awaited<
  ReturnType<typeof fetchGithubConnectorStatus>
>

export async function fetchGithubConnectorStatus(
  orgSlug: string,
  connectionId: string,
): Promise<{
  connectionId: string
  installationComplete: boolean
  hasAppCredentials: boolean
  webhookUrl: string
  githubAppInstallSelectUrl: string | null
  suggestedNextStep: "save_credentials" | "install_app" | "complete"
}> {
  const res = await client[":orgSlug"].api.v1.github.installation[
    "connector-status"
  ].$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load GitHub connector status",
  })
}
