/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? This file is the one registry of catalog entries that each
 * variant reads, and the rule that turns the org's connections into the
 * state of an entry.
 */
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
import { LinearMark } from "../components/LinearMark"
import { PagerdutyMark } from "../components/PagerdutyMark"
import { PlainMark } from "../components/PlainMark"
import type { OrgConnectionListItem } from "../queries/org-connections"
import { ConfluenceOutlineMark, ZendeskMark } from "./marks"
import type { CatalogFacts } from "./prototype-variant"

export const CATALOG_GROUPS = [
  {
    id: "code",
    name: "Code and CI",
    about: "What the code does, how it builds, and who owns it.",
  },
  {
    id: "docs",
    name: "Docs and design",
    about: "Specs, decisions, wikis, and design files.",
  },
  {
    id: "work",
    name: "Work tracking",
    about: "Projects, issues, and what the team plans next.",
  },
  {
    id: "conversations",
    name: "Conversations",
    about: "Answers that live in chat threads.",
  },
  {
    id: "support",
    name: "Support",
    about: "What customers ask, and the articles that answer them.",
  },
  {
    id: "operations",
    name: "Operations",
    about: "Incidents and alerts from production.",
  },
] as const

export type CatalogGroupId = (typeof CATALOG_GROUPS)[number]["id"]

export type CatalogId =
  | "github"
  | "buildkite"
  | "backstage"
  | "confluence"
  | "notion"
  | "google-drive"
  | "figma"
  | "linear"
  | "slack"
  | "plain"
  | "zendesk"
  | "pagerduty"

/** The entries that main can start today. */
export type StartableId = Exclude<
  CatalogId,
  "zendesk" | "google-drive" | "figma" | "backstage"
>

export type CatalogEntry = {
  id: CatalogId
  name: string
  description: string
  group: CatalogGroupId
  Mark: ComponentType<{ className?: string }>
  /**
   * `hosted_pending`: available on self-host only, until the provider
   * approves our global OAuth client.
   */
  availability: "available" | "hosted_pending" | "coming_soon"
  connectionType?: OrgConnectionListItem["type"]
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Sync code and docs from selected repositories.",
    group: "code",
    Mark: IconBrandGithub,
    availability: "available",
    connectionType: "github",
  },
  {
    id: "buildkite",
    name: "Buildkite",
    description: "Sync the latest builds of selected pipelines.",
    group: "code",
    Mark: BuildkiteMark,
    availability: "available",
    connectionType: "buildkite",
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
    id: "confluence",
    name: "Confluence",
    description: "Sync pages from selected Confluence spaces.",
    group: "docs",
    Mark: ConfluenceOutlineMark,
    availability: "available",
    connectionType: "forge",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Sync specs, decisions, and docs from selected pages.",
    group: "docs",
    Mark: IconBrandNotion,
    availability: "available",
    connectionType: "notion",
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
    connectionType: "linear",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Capture a thread into a Workspace when you mention the bot.",
    group: "conversations",
    Mark: IconBrandSlack,
    availability: "available",
    connectionType: "slack",
  },
  {
    id: "plain",
    name: "Plain",
    description:
      "Sync Help Center articles and the threads of selected labels.",
    group: "support",
    Mark: PlainMark,
    availability: "available",
    connectionType: "plain",
  },
  {
    id: "zendesk",
    name: "Zendesk",
    description: "Sync Help Center articles and the tickets of selected views.",
    group: "support",
    Mark: ZendeskMark,
    availability: "hosted_pending",
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    description: "Sync incidents and alerts of selected services.",
    group: "operations",
    Mark: PagerdutyMark,
    availability: "available",
    connectionType: "pagerduty",
  },
]

export const HOSTED_PENDING_REASON =
  "Zendesk is still reviewing our app. Self-hosted ctxpipe can connect now."

export type EntryState = {
  kind: "available" | "not_on_hosted" | "coming_soon"
  /** Healthy connections. */
  connected: number
  setupPending: number
  reconnect: number
}

export function entryState(
  entry: CatalogEntry,
  connections: readonly OrgConnectionListItem[],
  facts: CatalogFacts,
): EntryState {
  const own = connections.filter((row) => row.type === entry.connectionType)
  const setupPending = own.filter(
    (row) => facts.health[row.id] === "setup_pending",
  ).length
  const reconnect = own.filter(
    (row) => facts.health[row.id] === "reconnect",
  ).length
  const kind =
    entry.availability === "coming_soon"
      ? "coming_soon"
      : entry.availability === "hosted_pending" && facts.deployment === "hosted"
        ? "not_on_hosted"
        : "available"
  return {
    kind,
    connected: own.length - setupPending - reconnect,
    setupPending,
    reconnect,
  }
}

export function connectionCount(state: EntryState) {
  return state.connected + state.setupPending + state.reconnect
}

/**
 * One status for an entry, worst first. Null for an entry that is
 * available and not connected: it needs no label.
 */
export function entryStatus(state: EntryState): {
  label: string
  tone: "ok" | "warn" | "muted"
} | null {
  if (state.kind === "coming_soon")
    return { label: "Coming soon", tone: "muted" }
  if (state.kind === "not_on_hosted")
    return { label: "Self-host only", tone: "muted" }
  if (state.reconnect > 0) return { label: "Needs reconnect", tone: "warn" }
  if (state.setupPending > 0)
    return { label: "Setup not finished", tone: "muted" }
  if (state.connected > 1)
    return { label: `${state.connected} connected`, tone: "ok" }
  if (state.connected === 1) return { label: "Connected", tone: "ok" }
  return null
}

export function matchesFilter(entry: CatalogEntry, filter: string) {
  const query = filter.trim().toLowerCase()
  if (!query) return true
  const group = CATALOG_GROUPS.find((item) => item.id === entry.group)
  return [entry.name, entry.description, group?.name ?? ""].some((text) =>
    text.toLowerCase().includes(query),
  )
}
