import { getTokenProvider } from "@aws/bedrock-token-generator"

import type { OpenAiCompatibleFetch, ProviderCallEnv } from "./providerTypes.js"

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

export function resolveBedrockRegion(
  env: ProviderCallEnv,
  requestUrl?: string,
): string | undefined {
  const explicit =
    env.MODEL_BEDROCK_AWS_REGION?.trim() ||
    env.AWS_REGION?.trim() ||
    env.AWS_DEFAULT_REGION?.trim()
  if (explicit) return explicit
  const url = requestUrl ?? env.MODEL_PROVIDER_URL?.trim()
  if (url) return parseBedrockRegionFromBaseUrl(url)
  return undefined
}

export function createBedrockBearerFetch(region: string): OpenAiCompatibleFetch {
  const provideToken = getTokenProvider({ region })
  return async (input, init) => {
    const token = await provideToken()
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${token}`)
    return fetch(input as RequestInfo, { ...init, headers })
  }
}

export async function getBedrockBearerToken(region: string): Promise<string> {
  const provideToken = getTokenProvider({ region })
  return provideToken()
}
