import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { log } from "@clack/prompts"
import {
  AUTH_CLIENT_ID,
  DEVICE_GRANT_TYPE,
  DEFAULT_BASE_URL,
} from "./constants.js"
import { readJsonObject } from "./fs-operations.js"
import { isObject } from "./mcp/json.js"
import { normalizeBaseUrl } from "./mcp/paths.js"
import { openBrowser, sleep } from "./system.js"
import { muted, pathText } from "./ui.js"

export type StoredAuth = {
  baseUrl: string
  accessToken: string
  refreshToken: string | null
  tokenType: string
  expiresAt: string | null
  createdAt: string | null
}

export type Organization = {
  id: string | null
  name: string | null
  slug: string
}

type RequestOptions = {
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

export async function loginWithDeviceFlow({
  baseUrl = DEFAULT_BASE_URL,
}: {
  baseUrl?: string
}): Promise<StoredAuth> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const device = await requestDeviceCode(normalizedBaseUrl)
  const verificationUrl = absoluteUrl(
    stringField(device, "verification_uri_complete") ??
      requiredString(device, "verification_uri"),
    normalizedBaseUrl,
  )
  const userCode = stringField(device, "user_code")

  log.step("Open this URL")
  log.message(pathText(verificationUrl))
  if (userCode && !stringField(device, "verification_uri_complete")) {
    log.step("Enter code")
    log.message(userCode)
  }
  log.step("Waiting for approval")
  log.message(muted("Approve the request in your browser to continue."))

  openBrowser(verificationUrl)

  const token = await pollDeviceToken({
    baseUrl: normalizedBaseUrl,
    deviceCode: requiredString(device, "device_code"),
    interval: Number(device.interval ?? 5),
  })
  log.success("Approved.")
  const auth: StoredAuth = {
    baseUrl: normalizedBaseUrl,
    accessToken: requiredString(token, "access_token"),
    refreshToken: stringField(token, "refresh_token"),
    tokenType: stringField(token, "token_type") ?? "Bearer",
    expiresAt:
      typeof token.expires_in === "number"
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : null,
    createdAt: new Date().toISOString(),
  }
  writeStoredAuth(auth)
  return auth
}

async function requestDeviceCode(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await authFetch(baseUrl, "/device/code", {
    method: "POST",
    body: {
      client_id: AUTH_CLIENT_ID,
      scope: "openid profile email",
    },
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(authErrorMessage(json, "Could not start ctx| device login"))
  }
  const data = unwrapBetterAuthData(json)
  if (!isObject(data) || !data.device_code || !data.verification_uri) {
    throw new Error("Device login response was missing required fields")
  }
  return data
}

async function pollDeviceToken({
  baseUrl,
  deviceCode,
  interval,
}: {
  baseUrl: string
  deviceCode: string
  interval: number
}): Promise<Record<string, unknown>> {
  let pollingInterval = Math.max(interval, 1)
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    await sleep(pollingInterval * 1000 + 250)
    const response = await authFetch(baseUrl, "/device/token", {
      method: "POST",
      body: {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: AUTH_CLIENT_ID,
      },
    })
    const json = await response.json().catch(() => ({}))
    const data = unwrapBetterAuthData(json)
    if (response.ok && isObject(data) && data.access_token) return data

    const code = authErrorCode(json)
    if (code === "authorization_pending") continue
    if (code === "slow_down") {
      pollingInterval += 5
      continue
    }
    if (code === "access_denied") {
      throw new Error("The ctx| sign-in request was denied")
    }
    if (code === "expired_token") {
      throw new Error("The ctx| sign-in code expired")
    }
    throw new Error(authErrorMessage(json, "ctx| sign-in failed"))
  }
  throw new Error("ctx| sign-in timed out")
}

export async function fetchOrganizations({
  baseUrl,
  accessToken,
}: {
  baseUrl: string
  accessToken: string
}): Promise<Organization[]> {
  const response = await authFetch(baseUrl, "/organization/list", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(authErrorMessage(json, "Could not load ctx| organizations"))
  }
  const data = unwrapBetterAuthData(json)
  if (!Array.isArray(data)) return []
  return data
    .map((org): Organization => {
      const item = isObject(org) ? org : {}
      const slug = typeof item.slug === "string" ? item.slug : null
      return {
        id: typeof item.id === "string" ? item.id : null,
        name: typeof item.name === "string" ? item.name : slug,
        slug: slug ?? "",
      }
    })
    .filter((org) => org.slug)
}

export async function fetchSession({
  baseUrl,
  accessToken,
}: {
  baseUrl: string
  accessToken: string
}): Promise<Record<string, unknown>> {
  const response = await authFetch(baseUrl, "/get-session", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(authErrorMessage(json, "Could not load ctx| session"))
  }
  const data = unwrapBetterAuthData(json)
  return isObject(data) ? data : {}
}

async function authFetch(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const url = new URL(`/.auth/api/v1/auth${path}`, baseUrl)
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch (error) {
    throw new Error(authConnectionErrorMessage({ baseUrl, error }))
  }
}

function authConnectionErrorMessage({
  baseUrl,
  error,
}: {
  baseUrl: string
  error: unknown
}): string {
  const code =
    error instanceof Error &&
    isObject(error.cause) &&
    typeof error.cause.code === "string"
      ? ` (${error.cause.code})`
      : ""
  const localHint = baseUrl.includes(".localhost")
    ? " For local testing, use the backend's direct local URL, such as `--base-url http://127.0.0.1:<backend-port>`."
    : ""
  return `Could not reach ctx| auth at ${baseUrl}${code}.${localHint}`
}

export function readStoredAuth(baseUrl: string): StoredAuth | null {
  const data = readJsonObject(authStorePath(baseUrl))
  if (typeof data.accessToken !== "string" || !data.accessToken) return null
  return {
    baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : normalizeBaseUrl(baseUrl),
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : null,
    tokenType: typeof data.tokenType === "string" ? data.tokenType : "Bearer",
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
  }
}

export function writeStoredAuth(auth: StoredAuth): void {
  const path = authStorePath(auth.baseUrl)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
}

export function removeStoredAuth(baseUrl: string): void {
  const path = authStorePath(baseUrl)
  if (existsSync(path)) unlinkSync(path)
}

export function authStorePath(baseUrl: string): string {
  const safeBase = normalizeBaseUrl(baseUrl)
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
  return join(homedir(), ".config", "ctxpipe", `${safeBase}.auth.json`)
}

export function unwrapBetterAuthData(json: unknown): unknown {
  if (isObject(json) && "data" in json) return json.data
  return json
}

export function authErrorCode(json: unknown): string | null {
  if (!isObject(json)) return null
  if (typeof json.error === "string") return json.error
  if (isObject(json.error) && typeof json.error.error === "string") {
    return json.error.error
  }
  return null
}

export function authErrorMessage(json: unknown, fallback: string): string {
  if (isObject(json)) {
    if (typeof json.error_description === "string") return json.error_description
    if (typeof json.message === "string") return json.message
    if (typeof json.error === "string") return json.error
    if (isObject(json.error)) {
      if (typeof json.error.error_description === "string") {
        return json.error.error_description
      }
      if (typeof json.error.message === "string") return json.error.message
      if (typeof json.error.error === "string") return json.error.error
    }
  }
  return fallback
}

export function orgLabel(org: Organization): string {
  return org.name && org.name !== org.slug ? `${org.name} (${org.slug})` : org.slug
}

export function userLabel(session: Record<string, unknown> | null): string | null {
  const user = sessionUser(session)
  if (!user) return null
  return (
    stringField(user, "email") ??
    stringField(user, "name") ??
    stringField(user, "id") ??
    null
  )
}

export function sessionUser(
  session: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return session && isObject(session.user) ? session.user : null
}

function absoluteUrl(value: string, baseUrl: string): string {
  return new URL(value, baseUrl).toString()
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key)
  if (!field) throw new Error(`Missing ${key} in ctx| auth response`)
  return field
}
