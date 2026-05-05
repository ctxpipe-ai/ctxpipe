import { Sha256 } from "@aws-crypto/sha256-js"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { HttpRequest } from "@smithy/protocol-http"
import { SignatureV4 } from "@smithy/signature-v4"

import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
  ProviderCallResult,
} from "./providerTypes.js"

function parseBedrockRegionFromBaseUrl(fullUrl: string): string | undefined {
  try {
    const host = new URL(fullUrl).hostname
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
  env: ProviderCallOpts["env"],
  requestUrl: string,
): string | undefined {
  const explicit =
    env.MODEL_BEDROCK_AWS_REGION?.trim() ||
    env.AWS_REGION?.trim() ||
    env.AWS_DEFAULT_REGION?.trim()
  if (explicit) return explicit
  return parseBedrockRegionFromBaseUrl(requestUrl)
}

function createBedrockIamFetch(
  env: ProviderCallOpts["env"],
): OpenAiCompatibleFetch {
  return async (input, init): Promise<Response> => {
    const req = new Request(input as RequestInfo, init)
    const url = new URL(req.url)
    const region = resolveBedrockRegion(env, req.url)
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

function bearerFetchBedrock(apiKey: string): OpenAiCompatibleFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${apiKey}`)
    return fetch(input as RequestInfo, { ...init, headers })
  }
}

export function callBedrock(opts: ProviderCallOpts): ProviderCallResult {
  const baseURL = opts.env.MODEL_PROVIDER_URL?.trim()
  if (!baseURL) {
    throw new Error("MODEL_PROVIDER_URL is required for MODEL_PROVIDER=bedrock")
  }

  if (opts.apiKey.trim()) {
    const fetchFn = bearerFetchBedrock(opts.apiKey)
    return {
      configuration: { baseURL },
      fetch: fetchFn,
    }
  }

  const fetchFn = createBedrockIamFetch(opts.env)
  return {
    configuration: { baseURL, fetch: fetchFn },
    fetch: fetchFn,
  }
}
