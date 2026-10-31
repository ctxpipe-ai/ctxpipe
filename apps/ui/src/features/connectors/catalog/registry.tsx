import {
  IconBrandFigma,
  IconBrandGithub,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconBrandSlack,
  IconComponents,
} from "@tabler/icons-react"
import type { ComponentType } from "react"

import { BuildkiteMark } from "../components/BuildkiteMark"
import { ConfluenceMark } from "../components/ConfluenceMark"
import { LinearMark } from "../components/LinearMark"
import { PagerdutyMark } from "../components/PagerdutyMark"
import { PlainMark } from "../components/PlainMark"
import { ZendeskMark } from "../components/ZendeskMark"
import { registerAtlassianInstallIntent } from "../queries/atlassian-connector"
import {
  createLinearDraft,
  fetchLinearOauthApp,
} from "../queries/linear-connector"
import { createDraftNotionConnection } from "../queries/notion-connector"
import type { OrgConnectionListItem } from "../queries/org-connections"
import { startPagerdutySetup } from "../queries/pagerduty-connector"

/** The groups of the catalog, in the order of its views. */
export const CONNECTOR_GROUPS = [
  { id: "code", name: "Code and CI" },
  { id: "docs", name: "Docs and design" },
  { id: "work", name: "Work tracking" },
  { id: "conversations", name: "Conversations" },
  { id: "support", name: "Support" },
  { id: "operations", name: "Operations" },
] as const

export type ConnectorGroupId = (typeof CONNECTOR_GROUPS)[number]["id"]

/** The `type` of a connection row: one for each connector that can start. */
export type ConnectionType = OrgConnectionListItem["type"]

/**
 * What the Connectors page opens after a start: the setup dialog of the
 * connector. A start that makes a draft first gives its connection id.
 */
export type SetupTarget = { connectionId?: string }

/** A setup that the Connectors page must open. */
export type SetupRequest = SetupTarget & { type: ConnectionType }

/** What a start can use. */
export type ConnectorStartContext = {
  orgSlug: string
  /**
   * The GitHub App install. It runs in a popup that the catalog watches, so
   * the catalog stays open while it runs.
   */
  githubApp: {
    /**
     * Starts the install. True when the deployment has no hosted App: the
     * page must then open the self-hosted wizard.
     */
    install: () => boolean
    /** True while the install flow loads or runs. */
    isBusy: boolean
  }
}

type EntryBase = {
  name: string
  /** One line. It starts with "Sync" (Slack: "Capture"). */
  description: string
  group: ConnectorGroupId
  Mark: ComponentType<{ className?: string }>
}

/**
 * One connector of the catalog. A new connector adds one entry. A rule for
 * a new availability (for example a connector that only self-hosted ctxpipe
 * can start) adds one more member to this union. TypeScript then shows each
 * place that must handle it (`catalog-state.ts`, `ConnectorCatalogDialog`).
 */
export type ConnectorEntry =
  | (EntryBase & {
      id: ConnectionType
      availability: "available"
      /**
       * Starts the setup: the first request, when the setup needs a draft
       * row, then the setup that the page must open. Null when the start
       * runs on its own (the GitHub App popup) and the page opens nothing.
       */
      start: (context: ConnectorStartContext) => Promise<SetupTarget | null>
      /** True while the start runs outside the catalog. */
      isBusy?: (context: ConnectorStartContext) => boolean
    })
  | (EntryBase & {
      /** A planned connector: the catalog offers "Ask for it". */
      id: "backstage" | "figma" | "google-drive" | "zendesk"
      availability: "coming_soon"
    })

export type AvailableConnectorEntry = Extract<
  ConnectorEntry,
  { availability: "available" }
>

/** The start of a setup that needs no first request. */
const openSetup = async (): Promise<SetupTarget> => ({})

function ConfluenceOutlineMark({ className }: { className?: string }) {
  return <ConfluenceMark className={className} variant="outline" />
}

export const CONNECTOR_REGISTRY: readonly ConnectorEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Sync code and docs from selected repositories.",
    group: "code",
    Mark: IconBrandGithub,
    availability: "available",
    // The hosted App installs in a popup; self-hosted ctxpipe opens the
    // wizard that registers the org's own App.
    start: async ({ githubApp }) => (githubApp.install() ? {} : null),
    isBusy: ({ githubApp }) => githubApp.isBusy,
  },
  {
    id: "buildkite",
    name: "Buildkite",
    description: "Sync the latest builds of selected pipelines.",
    group: "code",
    Mark: BuildkiteMark,
    availability: "available",
    start: openSetup,
  },
  {
    id: "backstage",
    name: "Backstage",
    description: "Sync the software catalog: services, owners, and APIs.",
    group: "code",
    Mark: IconComponents,
    availability: "coming_soon",
  },
  {
    id: "forge",
    name: "Confluence",
    description: "Sync pages from selected Confluence spaces.",
    group: "docs",
    Mark: ConfluenceOutlineMark,
    availability: "available",
    start: async ({ orgSlug }) => {
      const intent = await registerAtlassianInstallIntent(orgSlug)
      return { connectionId: intent.id }
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Sync specs, decisions, and docs from selected pages.",
    group: "docs",
    Mark: IconBrandNotion,
    availability: "available",
    start: async ({ orgSlug }) => {
      const draft = await createDraftNotionConnection(orgSlug)
      return { connectionId: draft.id }
    },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Sync docs and slides from selected folders.",
    group: "docs",
    Mark: IconBrandGoogleDrive,
    availability: "coming_soon",
  },
  {
    id: "figma",
    name: "Figma",
    description: "Sync design files and their comments from selected projects.",
    group: "docs",
    Mark: IconBrandFigma,
    availability: "coming_soon",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Sync projects, issues, documents, and customer requests.",
    group: "work",
    Mark: LinearMark,
    availability: "available",
    start: async ({ orgSlug }) => {
      // With the deployment's OAuth app, the setup makes its own draft.
      const oauth = await fetchLinearOauthApp(orgSlug)
      if (oauth.globalLinearOauthConfigured) return {}
      const draft = await createLinearDraft(orgSlug)
      return { connectionId: draft.connectionId }
    },
  },
  {
    id: "slack",
    name: "Slack",
    description: "Capture a thread into a Workspace when you mention the bot.",
    group: "conversations",
    Mark: IconBrandSlack,
    availability: "available",
    start: openSetup,
  },
  {
    id: "plain",
    name: "Plain",
    description:
      "Sync Help Center articles and the threads of selected labels.",
    group: "support",
    Mark: PlainMark,
    availability: "available",
    start: openSetup,
  },
  {
    id: "zendesk",
    name: "Zendesk",
    description: "Sync Help Center articles and the tickets of selected views.",
    group: "support",
    Mark: ZendeskMark,
    availability: "coming_soon",
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    description: "Sync incidents and alerts of selected services.",
    group: "operations",
    Mark: PagerdutyMark,
    availability: "available",
    start: async ({ orgSlug }) => {
      const setup = await startPagerdutySetup(orgSlug)
      return { connectionId: setup.connectionId ?? undefined }
    },
  },
]
