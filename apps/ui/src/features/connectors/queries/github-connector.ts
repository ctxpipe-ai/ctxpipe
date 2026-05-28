import { client } from "@/lib/api"

export const githubConnectorKeys = {
  bootstrap: (orgSlug: string) =>
    ["github-connector-bootstrap", orgSlug] as const,
  installation: (orgSlug: string, connectionId?: string) =>
    [
      "github-installation",
      orgSlug,
      connectionId ?? "default",
    ] as const,
  connectorStatus: (orgSlug: string, connectionId: string) =>
    ["github-connector-status", orgSlug, connectionId] as const,
  /** Prefix: invalidate all per-org github installation queries */
  allInstallationForOrg: (orgSlug: string) =>
    ["github-installation", orgSlug] as const,
}

export async function fetchGithubConnectorBootstrap(
  orgSlug: string,
): Promise<{
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
  if (!res.ok) throw new Error("Failed to load GitHub connector bootstrap")
  return res.json()
}

export type GithubConnectorBootstrap = Awaited<
  ReturnType<typeof fetchGithubConnectorBootstrap>
>

export async function fetchGithubInstallationSummary(
  orgSlug: string,
): Promise<{
  id: string
  appSlug: string | null
  installationId: number | null
} | null> {
  const res = await client[":orgSlug"].api.v1.github.installation.$get({
    param: { orgSlug },
  })
  if (!res.ok) throw new Error("Failed to check GitHub installation")
  return res.json()
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
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? "Failed to save connector")
  }
  const data = (await res.json()) as { id: string }
  return data
}

export async function createGithubDraftPlaceholder(orgSlug: string): Promise<{
  id: string
  webhookUrl: string
}> {
  const res = await fetch(
    `/${orgSlug}/api/v1/github/installation/draft/placeholder`,
    { method: "POST", credentials: "include" },
  )
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? "Failed to reserve connector")
  }
  return res.json() as Promise<{ id: string; webhookUrl: string }>
}

export async function patchGithubDraftConnection(
  orgSlug: string,
  body: CreateGithubDraftBody & { connectionId: string },
): Promise<{ id: string }> {
  const res = await fetch(`/${orgSlug}/api/v1/github/installation/draft`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? "Failed to save connector")
  }
  const data = (await res.json()) as { id: string }
  return data
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
  if (!res.ok) throw new Error("Failed to load GitHub connector status")
  return res.json()
}
