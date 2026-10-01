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
