import { decrypt } from "../crypto.js"
import type { ConfluenceClientConfig } from "./client.js"

type ConnectorConfig = {
  confluenceBaseUrl?: string
  confluenceEmail?: string
  confluenceApiToken?: string
  deploymentType?: string
  cloudId?: string
  oauthRefreshToken?: string
  oauthClientId?: string
  oauthClientSecret?: string
}

/**
 * Build a ConfluenceClientConfig from a connector's stored config.
 * Returns null if neither OAuth nor basic-auth credentials are present.
 */
export function buildConfluenceConfig(config: ConnectorConfig): ConfluenceClientConfig | null {
  if (config.oauthRefreshToken) {
    const isCloud = config.deploymentType !== "datacenter"
    return {
      authType: "oauth",
      apiBaseUrl: isCloud
        ? `https://api.atlassian.com/ex/confluence/${config.cloudId}`
        : (config.confluenceBaseUrl ?? "").replace(/\/$/, ""),
      refreshToken: decrypt(config.oauthRefreshToken),
      clientId: isCloud
        ? (process.env.ATLASSIAN_CLIENT_ID ?? "")
        : (config.oauthClientId ?? ""),
      clientSecret: isCloud
        ? (process.env.ATLASSIAN_CLIENT_SECRET ?? "")
        : (config.oauthClientSecret ?? ""),
      tokenUrl: isCloud
        ? "https://auth.atlassian.com/oauth/token"
        : `${(config.confluenceBaseUrl ?? "").replace(/\/$/, "")}/rest/oauth2/latest/token`,
    }
  }

  if (config.confluenceBaseUrl && config.confluenceEmail && config.confluenceApiToken) {
    return {
      authType: "basic",
      baseUrl: config.confluenceBaseUrl,
      email: config.confluenceEmail,
      apiToken: config.confluenceApiToken,
    }
  }

  return null
}
