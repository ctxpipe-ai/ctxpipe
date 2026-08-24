import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { request } from "node:https"
import { BlockList, isIP } from "node:net"
import { basename, extname } from "node:path"
import slugify from "@sindresorhus/slugify"
import type { CommitFile } from "../github/installation-write-client.js"

export const CONNECTOR_ASSET_MAX_BYTES = 25 * 1024 * 1024
export const CONNECTOR_ENTITY_MAX_BYTES = 100 * 1024 * 1024

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
}

export function createConnectorAssetBudget(input?: {
  maxAssetBytes?: number
  maxEntityBytes?: number
}): ConnectorAssetBudget {
  return {
    maxAssetBytes: input?.maxAssetBytes ?? CONNECTOR_ASSET_MAX_BYTES,
    remainingBytes: input?.maxEntityBytes ?? CONNECTOR_ENTITY_MAX_BYTES,
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

export function sanitizeConnectorAssetName(filename: string): string {
  const leaf = basename(filename.trim().replaceAll("\\", "/"))
  const extension = extname(leaf)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
  const stem = extension ? leaf.slice(0, -extension.length) : leaf
  const safeStem = slugify(stem, { lowercase: true }).slice(0, 100)
  return `${safeStem || "attachment"}${extension.slice(0, 16)}`
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
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
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

async function requestConnectorAsset(input: {
  url: URL
  address: string
  family: 4 | 6
  headers: Record<string, string>
  maxBytes: number
}): Promise<ConnectorAssetResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      input.url,
      {
        headers: { "accept-encoding": "identity", ...input.headers },
        lookup: (_hostname, _options, callback) => {
          callback(null, input.address, input.family)
        },
      },
      (response) => {
        const declaredLength = Number(response.headers["content-length"])
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > input.maxBytes
        ) {
          response.destroy()
          reject(new ConnectorAssetTooLargeError("Asset exceeds byte limit"))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        response.on("data", (chunk: Buffer | Uint8Array) => {
          const bytes = Buffer.from(chunk)
          total += bytes.byteLength
          if (total > input.maxBytes) {
            response.destroy(
              new ConnectorAssetTooLargeError("Asset exceeds byte limit"),
            )
            return
          }
          chunks.push(bytes)
        })
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        })
        response.on("error", reject)
      },
    )
    req.setTimeout(30_000, () => {
      req.destroy(new Error("Connector asset download timed out"))
    })
    req.on("error", reject)
    req.end()
  })
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
  let current: URL
  try {
    current = new URL(input.url)
  } catch {
    return { status: "stub", reason: "invalid_url" }
  }
  const credentialHost = current.hostname
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (
      current.protocol !== "https:" ||
      current.username ||
      current.password ||
      current.port
    ) {
      return { status: "stub", reason: "unsafe_url" }
    }
    const hostnameForLookup = current.hostname.replace(/^\[|\]$/g, "")
    let addresses: Array<{ address: string; family: number }>
    try {
      addresses = await lookup(hostnameForLookup, {
        all: true,
        verbatim: true,
      })
    } catch {
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
    const selected = addresses[0]
    if (!selected || (selected.family !== 4 && selected.family !== 6)) {
      return { status: "stub", reason: "unsafe_url" }
    }
    const headers = connectorAssetHeadersForHost({
      hostname: current.hostname,
      credentialHost,
      headers: input.headers,
      authenticatedHosts: input.authenticatedHosts,
    })
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
      })
    } catch (error) {
      return {
        status: "stub",
        reason:
          error instanceof ConnectorAssetTooLargeError
            ? input.budget.remainingBytes < input.budget.maxAssetBytes
              ? "entity_limit"
              : "asset_limit"
            : "download_failed",
      }
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.location
    ) {
      if (redirect === 5) return { status: "stub", reason: "download_failed" }
      const location = Array.isArray(response.headers.location)
        ? response.headers.location[0]
        : response.headers.location
      if (!location) return { status: "stub", reason: "download_failed" }
      current = new URL(location, current)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "stub", reason: "download_failed" }
    }
    const consumed = consumeConnectorAssetBudget(
      input.budget,
      response.body.byteLength,
    )
    if (!consumed.ok) return { status: "stub", reason: consumed.reason }
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
