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
  eventType:
    | "avi:forge:installed:app"
    | "avi:forge:upgraded:app"
  environment: {
    id: string
  }
}

/** Shared fields for page / blogpost style payloads (summary). */
export type ConfluenceForgeEventBase = {
  eventCreatedDate: string
  atlassianId?: string
  suppressNotifications?: boolean
}

export type ConfluencePageCreatedForgeEvent = ConfluenceForgeEventBase & {
  eventType: "avi:confluence:created:page"
  content: {
    id: string
    type: "blogpost" | "page"
    subType?: "live"
    status: string
    title: string
    space: {
      id: number
      key: string
      alias: string
      name: string
      type: "global" | "personal"
      status: "current" | "archived"
    }
  }
}

export type ConfluencePageUpdatedForgeEvent = ConfluenceForgeEventBase & {
  eventType: "avi:confluence:updated:page"
  content: {
    id: string
    type: "blogpost" | "page"
    subType?: "live"
    status: string
    title: string
    space: {
      id: number
      key: string
      alias: string
      name: string
      type: "global" | "personal"
      status: "current" | "archived"
    }
  }
}

export type ConfluencePageDeletedForgeEvent = ConfluenceForgeEventBase & {
  eventType: "avi:confluence:deleted:page"
  content: {
    id: string
    type: "blogpost" | "page"
    subType?: "live"
    status: string
    title: string
    space: {
      id: number
      key: string
      alias: string
      name: string
      type: "global" | "personal"
      status: "current" | "archived"
    }
  }
}

export type ConfluenceSpaceUpdatedForgeEvent = ConfluenceForgeEventBase & {
  eventType: "avi:confluence:updated:space:V2"
  space: {
    id: number
    key: string
    alias: string
    name: string
    type: "global" | "personal"
    status: "current" | "archived"
  }
}

export type ConfluenceSpaceDeletedForgeEvent = ConfluenceForgeEventBase & {
  eventType: "avi:confluence:deleted:space:V2"
  space: {
    id: number
    key: string
    alias: string
    name: string
    type: "global" | "personal"
    status: "current" | "archived"
  }
}

export type ConfluenceHandledForgeEvent =
  | ConfluencePageCreatedForgeEvent
  | ConfluencePageUpdatedForgeEvent
  | ConfluencePageDeletedForgeEvent
  | ConfluenceSpaceUpdatedForgeEvent
  | ConfluenceSpaceDeletedForgeEvent

export type ConfluenceHandledEventType = ConfluenceHandledForgeEvent["eventType"]
