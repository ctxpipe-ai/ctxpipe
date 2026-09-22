import { authClient } from "@/lib/auth-client"

const ORG_API_KEY_CONFIG_ID = "organization"
const PERSONAL_API_KEY_CONFIG_ID = "default"

export type ApiKey = {
  id: string
  name?: string | null
  start?: string | null
  expiresAt?: Date | string | null
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
}) {
  const created = (await authClient.apiKey.create({
    ...apiKeyOwnerFields(input.owner),
    name: input.name,
    expiresIn: input.expiresIn ?? undefined,
    fetchOptions: { throw: true },
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
}) {
  return createApiKey({ ...input, owner: { kind: "personal" } })
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
