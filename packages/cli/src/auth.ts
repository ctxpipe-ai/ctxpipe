import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { log, spinner } from "@clack/prompts"
import { AsyncEntry } from "@napi-rs/keyring"

import {
  AUTH_CLIENT_ID,
  DEFAULT_BASE_URL,
  DEVICE_GRANT_TYPE,
} from "./constants.js"
import { readJsonObject } from "./fs-operations.js"
import { isObject } from "./mcp/json.js"
import { normalizeBaseUrl } from "./mcp/paths.js"
import { openBrowser, sleep } from "./system.js"
import { pathText } from "./ui.js"

const KEYRING_SERVICE = "ctxpipe"

let keyringFallbackWarned = false

type StoredAuth = {
  baseUrl: string
  accessToken: string
  refreshToken: string | null
  tokenType: string
  expiresAt: string | null
  createdAt: string | null
}

type RequestOptions = {
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

function keyringAccount(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl)
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function warnKeyringFallback(): void {
  if (keyringFallbackWarned) return
  keyringFallbackWarned = true
  console.error(
    "ctxpipe: could not use the system keyring; credentials will be stored in a local file instead.",
  )
}

function authEntry(baseUrl: string): AsyncEntry {
  return new AsyncEntry(KEYRING_SERVICE, keyringAccount(baseUrl))
}

function storedAuthFromJsonData(
  data: Record<string, unknown>,
  baseUrl: string,
): StoredAuth | null {
  if (typeof data.accessToken !== "string" || !data.accessToken) return null
  return {
    baseUrl:
      typeof data.baseUrl === "string"
        ? data.baseUrl
        : normalizeBaseUrl(baseUrl),
    accessToken: data.accessToken,
    refreshToken:
      typeof data.refreshToken === "string" ? data.refreshToken : null,
    tokenType: typeof data.tokenType === "string" ? data.tokenType : "Bearer",
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
  }
}

function readStoredAuthFromFile(baseUrl: string): StoredAuth | null {
  const data = readJsonObject(authStorePath(baseUrl))
  return storedAuthFromJsonData(data, baseUrl)
}

function writeStoredAuthToFile(auth: StoredAuth): void {
  const path = authStorePath(auth.baseUrl)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
}

function removeStoredAuthFromFile(baseUrl: string): void {
  const path = authStorePath(baseUrl)
  if (existsSync(path)) unlinkSync(path)
}

export async function readStoredAuth(
  baseUrl: string,
): Promise<StoredAuth | null> {
  try {
    const password = await authEntry(baseUrl).getPassword()
    if (password?.trim()) {
      const parsed: unknown = JSON.parse(password)
      if (isObject(parsed)) {
        const fromKeyring = storedAuthFromJsonData(parsed, baseUrl)
        if (fromKeyring) return fromKeyring
      }
    }
  } catch {
    // fall through to file
  }
  return readStoredAuthFromFile(baseUrl)
}

async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  try {
    await authEntry(auth.baseUrl).setPassword(JSON.stringify(auth))
    removeStoredAuthFromFile(auth.baseUrl)
  } catch {
    warnKeyringFallback()
    writeStoredAuthToFile(auth)
  }
}

export async function removeStoredAuth(baseUrl: string): Promise<void> {
  try {
    await authEntry(baseUrl).deletePassword()
  } catch {
    // ignore missing keyring entry
  }
  removeStoredAuthFromFile(baseUrl)
}

function authStorePath(baseUrl: string): string {
  const safeBase = keyringAccount(baseUrl)
  return join(homedir(), ".config", "ctxpipe", `${safeBase}.auth.json`)
}

export async function loginWithDeviceFlow({
  baseUrl = DEFAULT_BASE_URL,
}: {
  baseUrl?: string
}): Promise<StoredAuth> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const signInSpinner = spinner()
  signInSpinner.start("Starting ctxpipe sign-in")
  let device: Record<string, unknown>
  try {
    device = await requestDeviceCode(normalizedBaseUrl)
    signInSpinner.stop("Sign-in request ready")
  } catch (error) {
    signInSpinner.stop("Could not start sign-in")
    throw error
  }
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
  openBrowser(verificationUrl)

  const approvalSpinner = spinner()
  approvalSpinner.start("Waiting for approval in your browser")
  let token: Record<string, unknown>
  try {
    token = await pollDeviceToken({
      baseUrl: normalizedBaseUrl,
      deviceCode: requiredString(device, "device_code"),
      interval: Number(device.interval ?? 5),
    })
    approvalSpinner.stop("Approved")
  } catch (error) {
    approvalSpinner.stop("Approval did not complete")
    throw error
  }
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
  await writeStoredAuth(auth)
  return auth
}

async function requestDeviceCode(
  baseUrl: string,
): Promise<Record<string, unknown>> {
  const response = await authFetch(baseUrl, "/device/code", {
    method: "POST",
    body: {
      client_id: AUTH_CLIENT_ID,
      scope: "openid profile email",
    },
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(
      authErrorMessage(json, "Could not start ctxpipe device login"),
    )
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
      throw new Error("The ctxpipe sign-in request was denied")
    }
    if (code === "expired_token") {
      throw new Error("The ctxpipe sign-in code expired")
    }
    throw new Error(authErrorMessage(json, "ctxpipe sign-in failed"))
  }
  throw new Error("ctxpipe sign-in timed out")
}

/** Read `.ctxpipe/config.json` from cwd or any ancestor; returns null if absent. */
type CtxpipeRepoConfig = {
  baseUrl: string | null
}

export function readStoredCtxpipeConfig(cwd: string): CtxpipeRepoConfig | null {
  let dir = resolve(cwd)
  // walk up until we hit the filesystem root
  while (true) {
    const candidate = join(dir, ".ctxpipe", "config.json")
    if (existsSync(candidate)) {
      const data = readJsonObject(candidate)
      return {
        baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : null,
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** CLI `--base-url` wins; otherwise fall back to repo config, then SaaS default. */
export function resolveCtxpipeBaseUrl(
  cwd: string,
  cliBaseUrl: string = DEFAULT_BASE_URL,
): string {
  const fromCli = normalizeBaseUrl(cliBaseUrl)
  if (fromCli !== DEFAULT_BASE_URL) return fromCli
  const config = readStoredCtxpipeConfig(cwd)
  if (config?.baseUrl) return normalizeBaseUrl(config.baseUrl)
  return fromCli
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
    throw new Error(authErrorMessage(json, "Could not load ctxpipe session"))
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
  return `Could not reach ctxpipe auth at ${baseUrl}${code}.${localHint}`
}

function unwrapBetterAuthData(json: unknown): unknown {
  if (isObject(json) && "data" in json) return json.data
  return json
}

function authErrorCode(json: unknown): string | null {
  if (!isObject(json)) return null
  if (typeof json.error === "string") return json.error
  if (isObject(json.error) && typeof json.error.error === "string") {
    return json.error.error
  }
  return null
}

function authErrorMessage(json: unknown, fallback: string): string {
  if (isObject(json)) {
    if (typeof json.error_description === "string")
      return json.error_description
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

export function userLabel(
  session: Record<string, unknown> | null,
): string | null {
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

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key)
  if (!field) throw new Error(`Missing ${key} in ctxpipe auth response`)
  return field
}
