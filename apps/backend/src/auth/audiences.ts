const oauthValidAudiences: string[] = []

function normalizeAudienceUrl(value: string): string | null {
  try {
    return new URL(value).toString()
  } catch {
    return null
  }
}

function ensureAudience(value: string) {
  if (!oauthValidAudiences.includes(value)) {
    oauthValidAudiences.push(value)
  }
}

export function getOAuthValidAudiences(baseUrl: string): string[] {
  console.log("getOAuthValidAudiences baseUrl", baseUrl)
  const normalizedBaseUrl = normalizeAudienceUrl(baseUrl)
  if (normalizedBaseUrl) {
    ensureAudience(normalizedBaseUrl)
  }
  return oauthValidAudiences
}

export function registerOAuthResourceAudience(
  resource: string,
  baseUrl: string,
) {
  const normalizedResource = normalizeAudienceUrl(resource)
  const normalizedBaseUrl = normalizeAudienceUrl(baseUrl)
  if (!normalizedResource || !normalizedBaseUrl) {
    return
  }

  const resourceUrl = new URL(normalizedResource)
  const baseUrlObject = new URL(normalizedBaseUrl)
  const isSameOrigin = resourceUrl.origin === baseUrlObject.origin
  const isOrgMcpPath = /^\/[^/]+\/mcp\/?$/.test(resourceUrl.pathname)
  if (!isSameOrigin || !isOrgMcpPath) {
    return
  }

  ensureAudience(resourceUrl.toString())
}
