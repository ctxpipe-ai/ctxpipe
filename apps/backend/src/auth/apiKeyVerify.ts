import type { BetterAuthInstance } from "./config.js"

/** Subset of Better Auth api-key verify response `key` field (no secret `key` string). */
export type VerifiedApiKeyRecord = {
  id: string
  configId: string
  referenceId: string
  permissions: Record<string, string[]> | null
}

export async function verifyApiKeyViaAuthHttp(
  auth: BetterAuthInstance,
  authBaseUrl: string,
  rawApiKey: string,
): Promise<
  | { ok: true; record: VerifiedApiKeyRecord }
  | { ok: false; status: number; body: unknown }
> {
  const url = new URL("/.auth/api/v1/auth/api-key/verify", authBaseUrl)
  const response = await auth.handler(
    new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: rawApiKey }),
    }),
  )
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    return { ok: false, status: response.status, body }
  }
  const parsed = body as {
    valid?: boolean
    key?: {
      id: string
      configId?: string
      referenceId: string
      permissions?: Record<string, string[]> | null
    } | null
  }
  if (!parsed.valid || !parsed.key) {
    return { ok: false, status: 401, body }
  }
  const k = parsed.key
  return {
    ok: true,
    record: {
      id: k.id,
      configId: k.configId ?? "default",
      referenceId: k.referenceId,
      permissions: k.permissions ?? null,
    },
  }
}

/** Bearer (non-JWT) or `x-api-key`, aligned with [`getApiKeyFromHeaders`] in auth/config.ts. */
export function extractRawApiKeyFromRequest(headers: Headers): string | null {
  const auth = headers.get("authorization")
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim()
    if (token.split(".").length === 3) return null
    return token.length > 0 ? token : null
  }
  const fromHeader = headers.get("x-api-key")
  return fromHeader?.trim() || null
}
