/**
 * Payload shapes for Forge remote webhooks (lifecycle + Confluence product events).
 * @see https://developer.atlassian.com/platform/forge/events-reference/confluence/
 */

/** Forge app install / upgrade / uninstall lifecycle events delivered to the remote endpoint. */
export type InstallationEvent = {
  id: string
  context: string // ari:cloud:confluence::site/cloudId
  installerAccountId: string
  app: {
    id: string
    version: string
    name?: string
    ownerAccountId?: string
  }
  eventType: "avi:forge:installed:app" | "avi:forge:upgraded:app"
  environment: {
    id: string
  }
}

