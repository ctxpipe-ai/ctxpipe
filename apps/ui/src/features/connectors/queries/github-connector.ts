import { queryOptions } from "@tanstack/react-query"
import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
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

export async function fetchGithubConnectorBootstrap(orgSlug: string) {
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
) {
  const res = await client[":orgSlug"].api.v1.github.installation.$get({
    param: { orgSlug },
    query: connectionId ? { connectionId } : {},
  })
  return readApiJson(res, { message: "Failed to check GitHub installation" })
}

export async function fetchGithubSetupLinkState(
  orgSlug: string,
): Promise<"linked" | "unlinked"> {
  const res = await client[":orgSlug"].api.v1.github.installation.$get({
    param: { orgSlug },
    query: {},
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
  const data = await readApiJson(res, {
    message: "Failed to check GitHub installation",
  })
  return githubSetupLinkStateFromSummaries([data])
}

/**
 * "linked" when any GitHub connection of the organization has an
 * installation. The key is under the installation prefix, so a GitHub setup
 * result refreshes it.
 */
export function githubSetupLinkOptions(orgSlug: string) {
  return queryOptions({
    queryKey: [...githubConnectorKeys.installation(orgSlug), "setup-link"],
    queryFn: () => fetchGithubSetupLinkState(orgSlug),
  })
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
) {
  const res = await client[":orgSlug"].api.v1.github.installation.draft.$post({
    param: { orgSlug },
    json: body,
  })
  return readApiJson(res, {
    message: "Failed to save connector",
  })
}

export async function createGithubDraftPlaceholder(orgSlug: string) {
  const res = await client[
    ":orgSlug"
  ].api.v1.github.installation.draft.placeholder.$post({ param: { orgSlug } })
  return readApiJson(res, {
    message: "Failed to reserve connector",
  })
}

export async function patchGithubDraftConnection(
  orgSlug: string,
  body: CreateGithubDraftBody & { connectionId: string },
) {
  const res = await client[":orgSlug"].api.v1.github.installation.draft.$patch({
    param: { orgSlug },
    json: body,
  })
  return readApiJson(res, {
    message: "Failed to save connector",
  })
}

export type GithubConnectorStatus = Awaited<
  ReturnType<typeof fetchGithubConnectorStatus>
>

export async function fetchGithubConnectorStatus(
  orgSlug: string,
  connectionId: string,
) {
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
