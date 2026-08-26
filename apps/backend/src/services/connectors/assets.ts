import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { request } from "node:https"
import { BlockList, isIP } from "node:net"
import { basename, extname } from "node:path"
import slugify from "@sindresorhus/slugify"
import type { CommitFile } from "../github/installation-write-client.js"

export const CONNECTOR_ASSET_MAX_BYTES = 25 * 1024 * 1024
export const CONNECTOR_ENTITY_MAX_BYTES = 100 * 1024 * 1024
export const CONNECTOR_ENTITY_MAX_ASSETS = 100
export const CONNECTOR_ENTITY_MAX_DOWNLOAD_MS = 2 * 60_000
export const CONNECTOR_SYNC_MAX_ASSET_BYTES = 64 * 1024 * 1024
export const CONNECTOR_SYNC_MAX_ASSETS = 250

const CONNECTOR_ASSET_MAX_ATTEMPTS = 3
const CONNECTOR_ASSET_REQUEST_TIMEOUT_MS = 30_000

const NON_PUBLIC_IPV6 = new BlockList()
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6")
}

export type ConnectorAssetBudget = {
  readonly maxAssetBytes: number
  remainingBytes: number
  remainingAssets: number
  readonly deadlineAt: number
}

export type ConnectorAssetBytePool = {
  remainingBytes: number
  remainingAssets: number
}

export function createConnectorAssetBytePool(
  maxBytes = CONNECTOR_SYNC_MAX_ASSET_BYTES,
  maxAssets = CONNECTOR_SYNC_MAX_ASSETS,
): ConnectorAssetBytePool {
  return { remainingBytes: maxBytes, remainingAssets: maxAssets }
}

export function consumeConnectorAssetBytePool(
  pool: ConnectorAssetBytePool,
  bytes: number,
): boolean {
  if (bytes < 0 || bytes > pool.remainingBytes || pool.remainingAssets <= 0) {
    return false
  }
  pool.remainingBytes -= bytes
  pool.remainingAssets -= 1
  return true
}

export function createConnectorAssetBudget(input?: {
  maxAssetBytes?: number
  maxEntityBytes?: number
  maxAssets?: number
  maxDurationMs?: number
}): ConnectorAssetBudget {
  return {
    maxAssetBytes: input?.maxAssetBytes ?? CONNECTOR_ASSET_MAX_BYTES,
    remainingBytes: input?.maxEntityBytes ?? CONNECTOR_ENTITY_MAX_BYTES,
    remainingAssets: input?.maxAssets ?? CONNECTOR_ENTITY_MAX_ASSETS,
    deadlineAt:
      Date.now() + (input?.maxDurationMs ?? CONNECTOR_ENTITY_MAX_DOWNLOAD_MS),
  }
}

export function consumeConnectorAssetBudget(
  budget: ConnectorAssetBudget,
  bytes: number,
):
  | { ok: true; remainingBytes: number }
  | {
      ok: false
      reason: "asset_limit" | "entity_limit"
      remainingBytes: number
    } {
  if (bytes > budget.maxAssetBytes) {
    return {
      ok: false,
      reason: "asset_limit",
      remainingBytes: budget.remainingBytes,
    }
  }
  if (bytes > budget.remainingBytes) {
    return {
      ok: false,
      reason: "entity_limit",
      remainingBytes: budget.remainingBytes,
    }
  }
  budget.remainingBytes -= bytes
  return { ok: true, remainingBytes: budget.remainingBytes }
}

export function consumeConnectorAssetTransferBytes(
  budget: ConnectorAssetBudget,
  bytes: number,
): boolean {
  if (bytes < 0 || bytes > budget.remainingBytes) {
    budget.remainingBytes = 0
    return false
  }
  budget.remainingBytes -= bytes
  return true
}

export function consumeConnectorAssetCandidate(
  budget: ConnectorAssetBudget,
): boolean {
  if (budget.remainingAssets <= 0 || budget.deadlineAt <= Date.now()) {
    return false
  }
  budget.remainingAssets -= 1
  return true
}

export function sanitizeConnectorAssetName(filename: string): string {
  const leaf = basename(filename.trim().replaceAll("\\", "/"))
  const extension = extname(leaf)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
  const stem = extension ? leaf.slice(0, -extension.length) : leaf
  const safeStem = slugify(stem, { lowercase: true }).slice(0, 100)
  return `${safeStem || "attachment"}${extension.slice(0, 16)}`
}

export function canonicalConnectorAssetUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    const keys = new Set(
      [...parsed.searchParams.keys()].map((key) => key.toLowerCase()),
    )
    const hasAwsSignature =
      keys.has("x-amz-signature") ||
      keys.has("x-amz-credential") ||
      (keys.has("signature") &&
        (keys.has("awsaccesskeyid") ||
          keys.has("key-pair-id") ||
          keys.has("policy")))
    const hasGoogleSignature =
      keys.has("x-goog-signature") || keys.has("x-goog-credential")
    const hasGoogleV2Signature =
      keys.has("signature") && keys.has("googleaccessid")
    const hasAzureSignature =
      keys.has("sig") &&
      keys.has("sv") &&
      ["se", "sp", "sr", "srt", "ss"].some((key) => keys.has(key))
    const azureSasKeys = new Set([
      "se",
      "sig",
      "si",
      "sip",
      "ske",
      "skoid",
      "sks",
      "skt",
      "sktid",
      "skv",
      "sp",
      "spr",
      "sr",
      "srt",
      "ss",
      "st",
      "sv",
    ])
    for (const key of [...parsed.searchParams.keys()]) {
      const normalised = key.toLowerCase()
      if (
        (hasGoogleSignature && normalised.startsWith("x-goog-")) ||
        (hasGoogleV2Signature &&
          (normalised === "expires" ||
            normalised === "googleaccessid" ||
            normalised === "signature")) ||
        (hasAwsSignature &&
          (normalised.startsWith("x-amz-") ||
            normalised === "awsaccesskeyid" ||
            normalised === "expires" ||
            normalised === "key-pair-id" ||
            normalised === "policy" ||
            normalised === "signature")) ||
        (hasAzureSignature && azureSasKeys.has(normalised))
      ) {
        parsed.searchParams.delete(key)
      }
    }
    parsed.searchParams.sort()
    return parsed.toString()
  } catch {
    return url
  }
}

export function gitBlobSha(bytes: Uint8Array): string {
  const body = Buffer.from(bytes)
  return createHash("sha1")
    .update(`blob ${body.byteLength}\0`)
    .update(body)
    .digest("hex")
}

export function connectorBlobUnchanged(
  path: string,
  bytes: Uint8Array,
  existingShaByPath: ReadonlyMap<string, string>,
): boolean {
  const existingSha = existingShaByPath.get(path)
  return Boolean(existingSha && existingSha === gitBlobSha(bytes))
}

export function connectorCommitFileUnchanged(
  file: CommitFile,
  existingShaByPath: ReadonlyMap<string, string>,
): boolean {
  const bytes =
    file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8")
  return connectorBlobUnchanged(file.path, bytes, existingShaByPath)
}

export function connectorPathMatchesPreservation(
  path: string,
  preservation: string,
): boolean {
  return preservation.endsWith("/") || preservation.endsWith("--")
    ? path.startsWith(preservation)
    : path === preservation
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number)
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false
  }
  const [a = 0, b = 0] = octets
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 31 && octets[2] === 196) ||
    (a === 192 && b === 52 && octets[2] === 193) ||
    (a === 192 && b === 88 && octets[2] === 99) ||
    (a === 192 && b === 175 && octets[2] === 48) ||
    (a === 192 && b === 2) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  )
}

function normalizedIpv6(address: string): string {
  return address.toLowerCase().split("%", 1)[0] ?? ""
}

export function isPublicConnectorAssetAddress(address: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    return isPublicIpv4(address)
  }
  const normalized = normalizedIpv6(address)
  if (isIP(normalized) !== 6) return false
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16)
  if (firstHextet < 0x2000 || firstHextet > 0x3fff) return false
  return !NON_PUBLIC_IPV6.check(normalized, "ipv6")
}

type ConnectorAssetResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

class ConnectorAssetTooLargeError extends Error {}
class ConnectorAssetEntityLimitError extends Error {}
class ConnectorAssetDeadlineError extends Error {}

type ConnectorAssetLookupCallback = {
  (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6): void
  (
    error: NodeJS.ErrnoException | null,
    addresses: Array<{ address: string; family: 4 | 6 }>,
  ): void
}

export function createPinnedConnectorAssetLookup(input: {
  address: string
  family: 4 | 6
}) {
  return (
    _hostname: string,
    options: number | { all?: boolean },
    callback: ConnectorAssetLookupCallback,
  ) => {
    if (typeof options === "object" && options.all) {
      callback(null, [input])
      return
    }
    callback(null, input.address, input.family)
  }
}

export function connectorAssetPinnedTlsOptions(input: {
  hostname: string
  address: string
  family: 4 | 6
}) {
  return {
    lookup: createPinnedConnectorAssetLookup(input),
    rejectUnauthorized: true as const,
    servername: input.hostname,
  }
}

async function requestConnectorAsset(input: {
  url: URL
  address: string
  family: 4 | 6
  headers: Record<string, string>
  maxBytes: number
  timeoutMs: number
  consumeBytes: (bytes: number) => boolean
}): Promise<ConnectorAssetResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      input.url,
      {
        headers: { "accept-encoding": "identity", ...input.headers },
        ...connectorAssetPinnedTlsOptions({
          hostname: input.url.hostname,
          address: input.address,
          family: input.family,
        }),
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          clearTimeout(timeout)
          const headers = response.headers
          response.destroy()
          resolve({
            status,
            headers,
            body: Buffer.alloc(0),
          })
          return
        }
        const declaredLength = Number(response.headers["content-length"])
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > input.maxBytes
        ) {
          clearTimeout(timeout)
          response.destroy()
          reject(new ConnectorAssetTooLargeError("Asset exceeds byte limit"))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        response.on("data", (chunk: Buffer | Uint8Array) => {
          const bytes = Buffer.from(chunk)
          total += bytes.byteLength
          if (!input.consumeBytes(bytes.byteLength)) {
            response.destroy(
              new ConnectorAssetEntityLimitError(
                "Entity asset byte limit exceeded",
              ),
            )
            return
          }
          if (total > input.maxBytes) {
            response.destroy(
              new ConnectorAssetTooLargeError("Asset exceeds byte limit"),
            )
            return
          }
          chunks.push(bytes)
        })
        response.on("end", () => {
          clearTimeout(timeout)
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        })
        response.on("error", (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        response.on("aborted", () => {
          clearTimeout(timeout)
          reject(new Error("Connector asset response aborted"))
        })
      },
    )
    const timeout = setTimeout(
      () => {
        req.destroy(new Error("Connector asset download timed out"))
      },
      Math.max(1, input.timeoutMs),
    )
    req.setTimeout(
      Math.min(CONNECTOR_ASSET_REQUEST_TIMEOUT_MS, input.timeoutMs),
      () => {
        req.destroy(new Error("Connector asset download timed out"))
      },
    )
    req.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    req.end()
  })
}

function connectorAssetDeadlineRemainingMs(
  budget: ConnectorAssetBudget,
): number {
  return Math.max(0, budget.deadlineAt - Date.now())
}

async function withConnectorAssetDeadline<T>(
  budget: ConnectorAssetBudget,
  operation: () => Promise<T>,
): Promise<T> {
  const remainingMs = connectorAssetDeadlineRemainingMs(budget)
  if (remainingMs <= 0) {
    throw new ConnectorAssetDeadlineError("Entity asset deadline exceeded")
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new ConnectorAssetDeadlineError("Entity asset deadline exceeded"),
            ),
          remainingMs,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function shouldRetryConnectorAssetStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status < 600)
  )
}

export function connectorAssetRetryDelayMs(
  attempt: number,
  response?: Pick<ConnectorAssetResponse, "headers">,
): number {
  const retryAfter = response?.headers["retry-after"]
  const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000
    }
    const date = Date.parse(value)
    if (Number.isFinite(date)) {
      return Math.max(0, date - Date.now())
    }
  }
  return 250 * 2 ** attempt
}

async function waitForConnectorAssetRetry(
  budget: ConnectorAssetBudget,
  delayMs: number,
): Promise<boolean> {
  if (delayMs >= connectorAssetDeadlineRemainingMs(budget)) return false
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  return true
}

export type ConnectorAssetDownloadResult =
  | {
      status: "downloaded"
      bytes: Buffer
      filename: string
      contentType: string | null
    }
  | {
      status: "stub"
      reason:
        | "invalid_url"
        | "unsafe_url"
        | "download_failed"
        | "asset_limit"
        | "entity_limit"
    }

export function connectorAssetHeadersForHost(input: {
  hostname: string
  credentialHost: string
  headers?: Record<string, string>
  authenticatedHosts?: readonly string[]
}): Record<string, string> {
  const trusted = new Set(
    (input.authenticatedHosts ?? []).map((host) => host.toLowerCase()),
  )
  const hostname = input.hostname.toLowerCase()
  return hostname === input.credentialHost.toLowerCase() &&
    trusted.has(hostname)
    ? (input.headers ?? {})
    : {}
}

function contentDispositionFilename(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      return undefined
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1]
}

function urlFilename(url: URL): string {
  const encoded = url.pathname.split("/").pop() || "attachment"
  try {
    return decodeURIComponent(encoded)
  } catch {
    return "attachment"
  }
}

export async function downloadConnectorAsset(input: {
  url: string
  budget: ConnectorAssetBudget
  filename?: string
  headers?: Record<string, string>
  authenticatedHosts?: readonly string[]
}): Promise<ConnectorAssetDownloadResult> {
  if (!consumeConnectorAssetCandidate(input.budget)) {
    return { status: "stub", reason: "entity_limit" }
  }

  let current: URL
  try {
    current = new URL(input.url)
  } catch {
    return { status: "stub", reason: "invalid_url" }
  }
  const credentialHost = current.hostname
  redirectLoop: for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (
      current.protocol !== "https:" ||
      current.username ||
      current.password ||
      current.port
    ) {
      return { status: "stub", reason: "unsafe_url" }
    }
    const hostnameForLookup = current.hostname.replace(/^\[|\]$/g, "")
    const headers = connectorAssetHeadersForHost({
      hostname: current.hostname,
      credentialHost,
      headers: input.headers,
      authenticatedHosts: input.authenticatedHosts,
    })
    for (
      let attempt = 0;
      attempt < CONNECTOR_ASSET_MAX_ATTEMPTS;
      attempt += 1
    ) {
      if (
        input.budget.remainingBytes <= 0 ||
        connectorAssetDeadlineRemainingMs(input.budget) <= 0
      ) {
        return { status: "stub", reason: "entity_limit" }
      }

      let addresses: Array<{ address: string; family: number }>
      try {
        addresses = await withConnectorAssetDeadline(input.budget, () =>
          lookup(hostnameForLookup, {
            all: true,
            verbatim: true,
          }),
        )
      } catch (error) {
        if (error instanceof ConnectorAssetDeadlineError) {
          return { status: "stub", reason: "entity_limit" }
        }
        if (
          attempt < CONNECTOR_ASSET_MAX_ATTEMPTS - 1 &&
          (await waitForConnectorAssetRetry(
            input.budget,
            connectorAssetRetryDelayMs(attempt),
          ))
        ) {
          continue
        }
        return { status: "stub", reason: "download_failed" }
      }
      if (
        addresses.length === 0 ||
        addresses.some(
          (address) => !isPublicConnectorAssetAddress(address.address),
        )
      ) {
        return { status: "stub", reason: "unsafe_url" }
      }
      const selected = addresses[attempt % addresses.length]
      if (!selected || (selected.family !== 4 && selected.family !== 6)) {
        return { status: "stub", reason: "unsafe_url" }
      }

      let response: ConnectorAssetResponse
      try {
        response = await requestConnectorAsset({
          url: current,
          address: selected.address,
          family: selected.family,
          headers,
          maxBytes: Math.min(
            input.budget.maxAssetBytes,
            input.budget.remainingBytes,
          ),
          timeoutMs: Math.min(
            CONNECTOR_ASSET_REQUEST_TIMEOUT_MS,
            connectorAssetDeadlineRemainingMs(input.budget),
          ),
          consumeBytes: (bytes) =>
            consumeConnectorAssetTransferBytes(input.budget, bytes),
        })
      } catch (error) {
        if (error instanceof ConnectorAssetDeadlineError) {
          return { status: "stub", reason: "entity_limit" }
        }
        if (error instanceof ConnectorAssetEntityLimitError) {
          return { status: "stub", reason: "entity_limit" }
        }
        if (error instanceof ConnectorAssetTooLargeError) {
          return {
            status: "stub",
            reason:
              input.budget.remainingBytes < input.budget.maxAssetBytes
                ? "entity_limit"
                : "asset_limit",
          }
        }
        if (
          attempt < CONNECTOR_ASSET_MAX_ATTEMPTS - 1 &&
          (await waitForConnectorAssetRetry(
            input.budget,
            connectorAssetRetryDelayMs(attempt),
          ))
        ) {
          continue
        }
        return { status: "stub", reason: "download_failed" }
      }

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.location
      ) {
        if (redirect === 5) {
          return { status: "stub", reason: "download_failed" }
        }
        const location = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location
        if (!location) return { status: "stub", reason: "download_failed" }
        try {
          current = new URL(location, current)
        } catch {
          return { status: "stub", reason: "invalid_url" }
        }
        continue redirectLoop
      }
      if (
        shouldRetryConnectorAssetStatus(response.status) &&
        attempt < CONNECTOR_ASSET_MAX_ATTEMPTS - 1 &&
        (await waitForConnectorAssetRetry(
          input.budget,
          connectorAssetRetryDelayMs(attempt, response),
        ))
      ) {
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        return { status: "stub", reason: "download_failed" }
      }
      const disposition = response.headers["content-disposition"]
      const dispositionValue = Array.isArray(disposition)
        ? disposition[0]
        : disposition
      const requestedName =
        input.filename ||
        contentDispositionFilename(dispositionValue) ||
        urlFilename(current)
      const contentType = response.headers["content-type"]
      return {
        status: "downloaded",
        bytes: response.body,
        filename: sanitizeConnectorAssetName(requestedName),
        contentType: Array.isArray(contentType)
          ? (contentType[0] ?? null)
          : (contentType ?? null),
      }
    }
    return { status: "stub", reason: "download_failed" }
  }
  return { status: "stub", reason: "download_failed" }
}

export function connectorAssetCommitFile(
  path: string,
  bytes: Uint8Array,
): CommitFile {
  return {
    path,
    content: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
  }
}

