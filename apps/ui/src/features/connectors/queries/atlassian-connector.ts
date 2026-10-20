import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"

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

export type OrgAtlassianOauthGet = Awaited<
  ReturnType<typeof fetchOrgAtlassianOauth>
>

export async function fetchOrgCapabilities(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.capabilities.$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load org capabilities",
  })
}

export async function fetchOrgAtlassianOauth(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.org["atlassian-oauth"].$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load org Atlassian OAuth settings",
  })
}

export async function saveOrgAtlassianOauth(
  orgSlug: string,
  connectionId: string,
  body: { clientId: string; clientSecret?: string },
): Promise<void> {
  const res = await client[":orgSlug"].api.v1.org["atlassian-oauth"].$put({
    param: { orgSlug },
    query: { connectionId },
    json: body,
  })
  await readApiJson(res, { message: "Failed to save the Atlassian OAuth app" })
}

export async function fetchAtlassianConnectorStatus(
  orgSlug: string,
  atlassianConnectionId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian.status.$get({
    param: { orgSlug },
    ...atlassianConnectionQuery(atlassianConnectionId),
  })
  return readApiJson(res, {
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
  await readApiJson(res, { message: "Failed to remove connector" })
}

export type ForgeProvisionStatusPayload = Awaited<
  ReturnType<typeof fetchForgeProvisionStatus>
>

export async function fetchForgeProvisionStatus(
  orgSlug: string,
  connectionId: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian[
    "provision-status"
  ].$get({
    param: { orgSlug },
    query: { connectionId },
  })
  return readApiJson(res, {
    message: "Failed to load Forge provision status",
  })
}

type ForgeProvisionRequestBody = {
  connectionId: string
  confluenceSiteHost: string
  forgeScopedApiToken: string
  forgeOperatorEmail: string
  confluenceForgeInstallUrl?: string
}

export async function postForgeProvision(
  orgSlug: string,
  body: ForgeProvisionRequestBody,
) {
  const res = await client[
    ":orgSlug"
  ].api.v1.connectors.atlassian.provision.$post({
    param: { orgSlug },
    json: body,
  })
  return readApiJson(res, {
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
  const json = await readApiJson(res, {
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
  await readApiJson(res, {
    emptyOn: [409],
    message: "Failed to cancel the Confluence setup",
  })
}

export async function fetchAtlassianSpaces(
  orgSlug: string,
  atlassianConnectionId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian[
    "available-spaces"
  ].$get({
    param: { orgSlug },
    ...atlassianConnectionQuery(atlassianConnectionId),
  })
  const json = await readApiJson(res, { message: "Failed to fetch spaces" })
  return json.items
}

/** The top-level pages of a space, or the children of `parentId`. */
export async function fetchAtlassianSpacePages(
  orgSlug: string,
  spaceKey: string,
  atlassianConnectionId?: string,
  parentId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian[
    "available-spaces"
  ][":spaceKey"].pages.$get({
    param: { orgSlug, spaceKey },
    query: {
      ...(parentId ? { parentId } : {}),
      ...(atlassianConnectionId ? { connectionId: atlassianConnectionId } : {}),
    },
  })
  const json = await readApiJson(res, {
    message: "Failed to fetch pages",
  })
  return json.items
}

export async function searchAtlassianSpacePages(
  orgSlug: string,
  spaceKey: string,
  q: string,
  atlassianConnectionId?: string,
) {
  const res = await client[":orgSlug"].api.v1.connectors.atlassian[
    "available-spaces"
  ][":spaceKey"].search.$get({
    param: { orgSlug, spaceKey },
    query: {
      q,
      ...(atlassianConnectionId ? { connectionId: atlassianConnectionId } : {}),
    },
  })
  const json = await readApiJson(res, {
    message: "Failed to search pages",
  })
  return json.items
}
