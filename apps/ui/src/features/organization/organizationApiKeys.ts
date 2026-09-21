import { authClient } from "@/lib/auth-client"

const ORG_API_KEY_CONFIG_ID = "organization"

export type OrgApiKey = {
  id: string
  name?: string | null
  start?: string | null
  expiresAt?: Date | string | null
}

export function organizationApiKeyListRequest(organizationId: string) {
  return {
    query: {
      configId: ORG_API_KEY_CONFIG_ID,
      organizationId,
    },
  } as const
}

export function organizationApiKeyCreateRequest(input: {
  organizationId: string
  name: string
  expiresIn: number | null
}) {
  return {
    configId: ORG_API_KEY_CONFIG_ID,
    organizationId: input.organizationId,
    name: input.name,
    expiresIn: input.expiresIn ?? undefined,
    fetchOptions: { throw: true },
  } as const
}

export function organizationApiKeyNeverExpiresRequest(keyId: string) {
  return {
    keyId,
    configId: ORG_API_KEY_CONFIG_ID,
    expiresIn: null,
    fetchOptions: { throw: true },
  } as const
}

export function organizationApiKeyDeleteRequest(keyId: string) {
  return {
    keyId,
    configId: ORG_API_KEY_CONFIG_ID,
    fetchOptions: { throw: true },
  } as const
}

export async function listOrganizationApiKeys(organizationId: string) {
  const result = await authClient.apiKey.list(
    organizationApiKeyListRequest(organizationId),
  )
  if (result.error) throw result.error
  const payload = result.data as { apiKeys?: OrgApiKey[] } | OrgApiKey[] | null
  if (Array.isArray(payload)) return payload
  return payload?.apiKeys ?? []
}

export async function createOrganizationApiKey(input: {
  organizationId: string
  name: string
  expiresIn: number | null
}) {
  const created = (await authClient.apiKey.create(
    organizationApiKeyCreateRequest(input),
  )) as OrgApiKey & { key?: string; id: string }

  if (input.expiresIn === null && created.id) {
    await authClient.apiKey.update(
      organizationApiKeyNeverExpiresRequest(created.id),
    )
  }

  return created
}

export async function deleteOrganizationApiKey(keyId: string) {
  await authClient.apiKey.delete(organizationApiKeyDeleteRequest(keyId))
}
