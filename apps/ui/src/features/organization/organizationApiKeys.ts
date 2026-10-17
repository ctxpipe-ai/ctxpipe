import { apiFetch, readApiJson } from "@/lib/api-result"
import { authClient } from "@/lib/auth-client"

const ORG_API_KEY_CONFIG_ID = "organization"
const PERSONAL_API_KEY_CONFIG_ID = "default"

export type ApiKey = {
  id: string
  name?: string | null
  start?: string | null
  expiresAt?: Date | string | null
}

export type PersonalApiKeyOrganization = {
  id: string
  slug: string
  name: string
}

type ApiKeyOwner =
  | { kind: "personal" }
  | { kind: "organization"; organizationId: string }

function apiKeyConfigId(owner: ApiKeyOwner) {
  return owner.kind === "organization"
    ? ORG_API_KEY_CONFIG_ID
    : PERSONAL_API_KEY_CONFIG_ID
}

function apiKeyOwnerFields(owner: ApiKeyOwner) {
  return owner.kind === "organization"
    ? {
        configId: apiKeyConfigId(owner),
        organizationId: owner.organizationId,
      }
    : { configId: apiKeyConfigId(owner) }
}

async function listApiKeys(owner: ApiKeyOwner) {
  const result = await authClient.apiKey.list({
    query: apiKeyOwnerFields(owner),
  })
  if (result.error) throw result.error
  const payload = result.data as { apiKeys?: ApiKey[] } | ApiKey[] | null
  if (Array.isArray(payload)) return payload
  return payload?.apiKeys ?? []
}

async function createApiKey(input: {
  owner: ApiKeyOwner
  name: string
  expiresIn: number | null
  /** Personal keys: the org set. The backend writes it before it answers. */
  organizationIds?: string[]
}) {
  const created = (await authClient.apiKey.create({
    ...apiKeyOwnerFields(input.owner),
    name: input.name,
    expiresIn: input.expiresIn ?? undefined,
    fetchOptions: {
      throw: true,
      headers: input.organizationIds
        ? {
            "x-ctxpipe-api-key-organizations": input.organizationIds.join(","),
          }
        : undefined,
    },
  })) as ApiKey & { key?: string; id: string }

  if (input.expiresIn === null && created.id) {
    await authClient.apiKey.update({
      keyId: created.id,
      configId: apiKeyConfigId(input.owner),
      expiresIn: null,
      fetchOptions: { throw: true },
    })
  }

  return created
}

async function deleteApiKey(
  configId: typeof ORG_API_KEY_CONFIG_ID | typeof PERSONAL_API_KEY_CONFIG_ID,
  keyId: string,
) {
  await authClient.apiKey.delete({
    keyId,
    configId,
    fetchOptions: { throw: true },
  })
}

export function listPersonalApiKeys() {
  return listApiKeys({ kind: "personal" })
}

export function createPersonalApiKey(input: {
  name: string
  expiresIn: number | null
  organizationIds: string[]
}) {
  return createApiKey({ ...input, owner: { kind: "personal" } })
}

const PERSONAL_API_KEYS_PATH = "/api/v1/me/api-keys"

/**
 * The org set of each personal key, by key id. `null`: a key from before org
 * sets, which reaches every organization of the user.
 */
export async function listPersonalApiKeyOrganizations(): Promise<
  Map<string, PersonalApiKeyOrganization[] | null>
> {
  const res = await apiFetch(PERSONAL_API_KEYS_PATH, { credentials: "include" })
  const body = await readApiJson<{
    keys: { id: string; organizations: PersonalApiKeyOrganization[] | null }[]
  }>(res, { message: "Could not load the organizations of the keys" })
  return new Map(body.keys.map((key) => [key.id, key.organizations]))
}

export async function setPersonalApiKeyOrganizations(input: {
  keyId: string
  organizationIds: string[]
}) {
  const res = await apiFetch(
    `${PERSONAL_API_KEYS_PATH}/${encodeURIComponent(input.keyId)}/organizations`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationIds: input.organizationIds }),
    },
  )
  await readApiJson<undefined>(res, {
    message: "Could not save the organizations",
  })
}

export function deletePersonalApiKey(keyId: string) {
  return deleteApiKey(PERSONAL_API_KEY_CONFIG_ID, keyId)
}

export function listOrganizationApiKeys(organizationId: string) {
  return listApiKeys({ kind: "organization", organizationId })
}

export function createOrganizationApiKey(input: {
  organizationId: string
  name: string
  expiresIn: number | null
}) {
  return createApiKey({
    name: input.name,
    expiresIn: input.expiresIn,
    owner: { kind: "organization", organizationId: input.organizationId },
  })
}

export function deleteOrganizationApiKey(keyId: string) {
  return deleteApiKey(ORG_API_KEY_CONFIG_ID, keyId)
}
