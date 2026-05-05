import { Sha256 } from "@aws-crypto/sha256-js"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { HttpRequest } from "@smithy/protocol-http"
import { SignatureV4 } from "@smithy/signature-v4"

type OpenAiCompatibleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function parseBedrockRegionFromBaseUrl(baseUrl: string): string | undefined {
  try {
    const host = new URL(baseUrl).hostname
    const mantle = host.match(/^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/i)
    if (mantle?.[1]) return mantle[1]
    const runtime = host.match(
      /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/i,
    )
    if (runtime?.[1]) return runtime[1]
    return undefined
  } catch {
    return undefined
  }
}

function resolveBedrockRegion(
  explicit: string | undefined,
  baseUrl: string,
): string | undefined {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed
  return (
    parseBedrockRegionFromBaseUrl(baseUrl) ??
    process.env.AWS_REGION?.trim() ??
    process.env.AWS_DEFAULT_REGION?.trim()
  )
}

/**
 * Returns a `fetch` that SigV4-signs each request for `MODEL_PROVIDER=bedrock` when using IAM
 * (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` via the default credentials chain).
 */
export function createBedrockSigV4Fetch(
  baseUrl: string,
  regionOverride?: string,
): OpenAiCompatibleFetch {
  const region = resolveBedrockRegion(regionOverride, baseUrl)
  if (!region) {
    throw new Error(
      "Bedrock IAM auth requires AWS region: set MODEL_BEDROCK_AWS_REGION or AWS_REGION, or use a MODEL_PROVIDER_URL host like bedrock-mantle.<region>.api.aws",
    )
  }

  const signer = new SignatureV4({
    credentials: fromNodeProviderChain(),
    region,
    service: "bedrock",
    sha256: Sha256,
  })

  return async (input, init): Promise<Response> => {
    const req = new Request(input as RequestInfo, init)
    const url = new URL(req.url)
    const method = req.method.toUpperCase()

    const bodyText =
      method === "GET" || method === "HEAD" ? undefined : await req.text()

    const headerEntries: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (
        lower === "authorization" ||
        lower === "x-amz-date" ||
        lower === "x-amz-security-token" ||
        lower === "x-amz-content-sha256"
      ) {
        return
      }
      headerEntries[key] = value
    })
    if (!headerEntries.host && !headerEntries.Host) {
      headerEntries.host = url.host
    }

    const pathWithQuery = `${url.pathname}${url.search}`

    const httpRequest = new HttpRequest({
      protocol: url.protocol.replace(":", "") as "http" | "https",
      hostname: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : undefined,
      method,
      path: pathWithQuery,
      headers: headerEntries,
      body: bodyText,
    })

    const signed = await signer.sign(httpRequest)

    const outHeaders = new Headers()
    for (const [k, v] of Object.entries(signed.headers)) {
      if (v === undefined) continue
      if (Array.isArray(v)) {
        for (const item of v) outHeaders.append(k, item)
      } else {
        outHeaders.set(k, String(v))
      }
    }

    const fetchInit: RequestInit = {
      method: signed.method,
      headers: outHeaders,
      body:
        signed.body !== undefined &&
        signed.method !== "GET" &&
        signed.method !== "HEAD"
          ? signed.body
          : undefined,
    }

    return fetch(req.url, fetchInit)
  }
}
