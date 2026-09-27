import { lookup } from "node:dns/promises"
import { request } from "node:https"
import { initEvlog, log } from "../observability/logger.js"
import {
  CONNECTOR_ENTITY_MAX_BYTES,
  connectorAssetPinnedTlsOptions,
  createConnectorAssetBudget,
  downloadConnectorAsset,
  isPublicConnectorAssetAddress,
} from "../services/connectors/assets.js"

initEvlog()

const [bunMajor = 0, bunMinor = 0, bunPatch = 0] = Bun.version
  .split(".")
  .map((part) => Number.parseInt(part, 10))
if (
  bunMajor < 1 ||
  (bunMajor === 1 && bunMinor < 3) ||
  (bunMajor === 1 && bunMinor === 3 && bunPatch < 11)
) {
  throw new Error(
    `Bun ${Bun.version} cannot safely pin HTTPS DNS; Bun 1.3.11 or newer is required`,
  )
}

const selectedAddress = (
  await lookup("www.google.com", {
    all: true,
  })
).filter(
  (
    candidate,
  ): candidate is {
    address: string
    family: 4 | 6
  } =>
    (candidate.family === 4 || candidate.family === 6) &&
    isPublicConnectorAssetAddress(candidate.address),
)[0]
if (!selectedAddress) {
  throw new Error("Runtime verification could not resolve a public address")
}
const { address, family } = selectedAddress
let lookupCalls = 0
await new Promise<void>((resolve, reject) => {
  const tlsOptions = connectorAssetPinnedTlsOptions({
    hostname: "www.google.com",
    address,
    family,
  })
  const pinnedLookup = tlsOptions.lookup
  const req = request(
    "https://www.google.com/robots.txt",
    {
      ...tlsOptions,
      lookup: (hostname, options, callback) => {
        lookupCalls += 1
        pinnedLookup(hostname, options, callback)
      },
    },
    (response) => {
      response.resume()
      response.on("end", resolve)
    },
  )
  req.setTimeout(10_000, () =>
    req.destroy(new Error("Timed out verifying connector DNS pinning")),
  )
  req.on("error", reject)
  req.end()
})
if (lookupCalls !== 1) {
  throw new Error(
    `Bun did not honour connector DNS pinning (lookup calls: ${lookupCalls})`,
  )
}

await new Promise<void>((resolve, reject) => {
  const req = request(
    "https://www.google.com/robots.txt",
    connectorAssetPinnedTlsOptions({
      hostname: "www.google.com",
      address: "1.1.1.1",
      family: 4,
    }),
    (response) => {
      response.destroy()
      reject(new Error("Bun ignored the callback-selected pinned address"))
    },
  )
  req.setTimeout(5_000, () =>
    req.destroy(new Error("Expected failure from deliberately wrong pin")),
  )
  req.on("error", () => resolve())
  req.end()
})

const expiredAddress = (await lookup("expired.badssl.com", { all: true })).find(
  (
    candidate,
  ): candidate is {
    address: string
    family: 4 | 6
  } =>
    (candidate.family === 4 || candidate.family === 6) &&
    isPublicConnectorAssetAddress(candidate.address),
)
if (!expiredAddress) {
  throw new Error("Runtime verification could not resolve expired.badssl.com")
}
const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
try {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      "https://expired.badssl.com/",
      connectorAssetPinnedTlsOptions({
        hostname: "expired.badssl.com",
        ...expiredAddress,
      }),
      (response) => {
        response.resume()
        reject(new Error("Explicit connector TLS verification was bypassed"))
      },
    )
    req.setTimeout(10_000, () =>
      req.destroy(new Error("Timed out verifying connector TLS rejection")),
    )
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "CERT_HAS_EXPIRED") {
        resolve()
        return
      }
      reject(error)
    })
    req.end()
  })
} finally {
  if (previousTlsSetting === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
  }
}

const result = await downloadConnectorAsset({
  url: "https://www.google.com/robots.txt",
  budget: createConnectorAssetBudget({ maxDurationMs: 20_000 }),
})

if (result.status !== "downloaded" || result.bytes.byteLength === 0) {
  throw new Error(
    `Connector asset runtime verification failed: ${
      result.status === "stub" ? result.reason : "empty response"
    }`,
  )
}

const authenticated = await downloadConnectorAsset({
  url: "https://httpbingo.org/headers",
  budget: createConnectorAssetBudget({ maxDurationMs: 20_000 }),
  headers: { authorization: "Bearer connector-runtime-smoke" },
  authenticatedHosts: ["httpbingo.org"],
})
if (authenticated.status !== "downloaded") {
  throw new Error(
    `Authenticated connector asset verification failed: ${authenticated.reason}`,
  )
}
const authenticatedHeaders = JSON.parse(
  authenticated.bytes.toString("utf8"),
) as { headers?: { Authorization?: string[] } }
if (
  authenticatedHeaders.headers?.Authorization?.[0] !==
  "Bearer connector-runtime-smoke"
) {
  throw new Error("Connector asset authentication header was not delivered")
}

const redirectBudget = createConnectorAssetBudget({ maxDurationMs: 20_000 })
const redirected = await downloadConnectorAsset({
  url: `https://httpbin.org/redirect-to?url=${encodeURIComponent(
    "https://httpbingo.org/headers",
  )}`,
  budget: redirectBudget,
  headers: { authorization: "Bearer must-not-cross-hosts" },
  authenticatedHosts: ["httpbin.org"],
})
if (redirected.status !== "downloaded") {
  throw new Error(
    `Redirected connector asset verification failed: ${redirected.reason}`,
  )
}
const redirectedHeaders = JSON.parse(redirected.bytes.toString("utf8")) as {
  headers?: { Authorization?: string[] }
}
if (redirectedHeaders.headers?.Authorization !== undefined) {
  throw new Error("Connector credential leaked across an asset redirect")
}
if (
  redirectBudget.remainingBytes !==
  CONNECTOR_ENTITY_MAX_BYTES - redirected.bytes.byteLength
) {
  throw new Error("Redirect response bodies consumed the entity asset budget")
}

log.info({
  step: "connector_assets.runtime_verified",
  message:
    "Connector DNS pinning, TLS rejection, authentication, and redirect stripping verified",
  downloadedBytes: result.bytes.byteLength,
})
