export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

export async function getJson(url: string, init: RequestInit, label: string): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 500)}`)
  try {
    const body: unknown = JSON.parse(text)
    return body
  } catch {
    throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
}

/** Throws the messages of a GraphQL `errors` array, if the body has one. */
export function throwGraphqlErrors(body: Record<string, unknown>, label: string): void {
  if (!Array.isArray(body.errors) || body.errors.length === 0) return
  const messages = body.errors.flatMap((error) => (isRecord(error) && typeof error.message === "string" ? [error.message] : []))
  throw new Error(messages.join("; ") || `${label} response had errors`)
}
