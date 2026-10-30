/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main.
 *
 * Question (CTX-1078): what should "Add connection" look like with 10+
 * connectors? Story data for the catalog prototype. Each scenario gives the
 * connection rows (the real list read), a status read for each row so the
 * page cards agree, and the facts the list does not give (`CatalogFacts`).
 * The names are made up.
 */
import { HttpResponse, http } from "msw"

import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import {
  buildkiteStatusHandler,
  buildkiteStoryStatus,
} from "@/mocks/buildkite-handlers"
import { plainStatusHandler, plainStoryStatus } from "@/mocks/plain-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  activeMemberRoleHandler,
  connectionUsageHandler,
} from "@/mocks/workspace-sources-handlers"

import type { OrgConnectionListItem } from "../queries/org-connections"
import type { CatalogFacts } from "./prototype-variant"

export const ORG = "acme"

type Row = Pick<OrgConnectionListItem, "id" | "type" | "displayName">

export type Scenario = {
  /** The story name. */
  name: string
  /** What the scenario shows, in one line. */
  about: string
  rows: Row[]
  facts: CatalogFacts
}

const syncTarget = {
  repositoryId: "repo_1",
  repositoryName: "acme/ctxpipe-context",
  branch: "main",
  githubConnectionId: "con_gh",
}
const live = {
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: true,
  syncTargetConfigured: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget,
}
const draft = {
  ...live,
  isInstalled: false,
  installationStatus: null,
  isGithubLinked: false,
  syncTargetConfigured: false,
  setupPhase: "draft",
  syncTarget: null,
}
const revoked = { ...live, installationStatus: "revoked" }

/** The status body of a row, from its type and its scenario health. */
function statusBody(row: Row, facts: CatalogFacts): object {
  const health = facts.health[row.id]
  const base =
    health === "setup_pending" ? draft : health === "reconnect" ? revoked : live
  switch (row.type) {
    case "forge":
      return {
        ...base,
        isLinked: true,
        selectedSpaceCount: 2,
        selectedSpaces: [{ spaceKey: "ENG", spaceName: "Engineering" }],
      }
    case "linear":
      return { ...base, workspaceName: row.displayName, selectedScopeCount: 3 }
    case "notion":
      return {
        ...base,
        workspaceName: row.displayName,
        selectedResourceCount: 4,
      }
    case "slack":
      return { ...base, teamName: row.displayName }
    case "pagerduty":
      return {
        ...base,
        accountName: row.displayName,
        accountSubdomain: "acme",
        region: "us",
        selectedServiceCount: 3,
        oauthAppSaved: false,
        globalPagerdutyOAuthConfigured: true,
        oauthCallbackUrl:
          "https://app.example.com/api/v1/integrations/pagerduty/callback",
      }
    default:
      return base
  }
}

const STATUS_PATH: Partial<Record<Row["type"], string>> = {
  forge: "/api/v1/connectors/atlassian/status",
  linear: "/api/v1/connectors/linear/status",
  notion: "/api/v1/connectors/notion/status",
  slack: "/api/v1/connectors/slack/status",
  pagerduty: "/api/v1/connectors/pagerduty/status",
}

function rowHandlers(row: Row, facts: CatalogFacts) {
  if (row.type === "github") {
    return [
      http.get(
        ({ request }) => {
          const url = new URL(request.url)
          return (
            url.pathname.endsWith("/api/v1/github/installation") &&
            url.searchParams.get("connectionId") === row.id
          )
        },
        () =>
          HttpResponse.json({
            id: row.id,
            installationId: 12345,
            accountSlug: row.displayName,
            ingestionRepositoryCount: 4,
          }),
      ),
    ]
  }
  if (row.type === "buildkite")
    return [
      buildkiteStatusHandler(buildkiteStoryStatus({ webhookConfigured: true })),
    ]
  if (row.type === "plain") return [plainStatusHandler(plainStoryStatus())]
  const path = STATUS_PATH[row.type]
  if (!path) return []
  return [
    http.get(
      ({ request }) => {
        const url = new URL(request.url)
        return (
          url.pathname.endsWith(path) &&
          url.searchParams.get("connectionId") === row.id
        )
      },
      () => HttpResponse.json(statusBody(row, facts)),
    ),
  ]
}

/** The first request of each catalog start, so the real setup opens. */
const startHandlers = [
  http.post(
    ({ request }) =>
      new URL(request.url).pathname.endsWith(
        "/api/v1/connectors/atlassian/installation",
      ),
    () => HttpResponse.json({ id: "con_cf_new" }),
  ),
  http.post(`/${ORG}/api/v1/connectors/notion/draft`, () =>
    HttpResponse.json({ id: "con_no_new", orgId: "org_story" }),
  ),
  http.post(`/${ORG}/api/v1/connectors/pagerduty/setup`, () =>
    HttpResponse.json({ connectionId: null }),
  ),
  http.get(`/${ORG}/api/v1/connectors/linear/oauth-app`, () =>
    HttpResponse.json({
      linearOauthConfigured: true,
      globalLinearOauthConfigured: true,
      oauthCallbackUrl:
        "https://app.example.com/api/v1/integrations/linear/callback",
    }),
  ),
  http.get(`/${ORG}/api/v1/org/atlassian-oauth`, ({ request }) =>
    HttpResponse.json({
      oauthAppSaved: true,
      atlassianOAuthClientId: "story-client",
      globalAtlassianOAuthConfigured: true,
      oauthCallbackUrl: `${new URL(request.url).origin}/api/v1/integrations/atlassian/callback`,
      atlassianCreateUrl:
        "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
    }),
  ),
  // The GitHub connect flow reads the org installation, with no connection.
  http.get(
    ({ request }) => {
      const url = new URL(request.url)
      return (
        url.pathname.endsWith("/api/v1/github/installation") &&
        !url.searchParams.get("connectionId")
      )
    },
    () => HttpResponse.json(null),
  ),
  // No hosted GitHub App: GitHub opens the self-hosted wizard of the page.
  githubConnectorBootstrapHandler({
    orgSlug: ORG,
    hostedDefaultAppInstallUrl: null,
  }),
]

export function scenarioMsw(scenario: Scenario) {
  return {
    page: [
      http.get(`/${ORG}/api/v1/connectors`, () =>
        HttpResponse.json({
          items: scenario.rows.map((row, index) => ({
            ...row,
            createdAt: `2026-0${(index % 9) + 1}-01T00:00:00.000Z`,
            updatedAt: "2026-10-01T00:00:00.000Z",
          })),
        }),
      ),
      ...scenario.rows.flatMap((row) => rowHandlers(row, scenario.facts)),
      ...startHandlers,
      connectionUsageHandler([]),
      workspaceListHandler([]),
      activeMemberRoleHandler("owner"),
    ],
  }
}

export const scenarios = {
  newOrg: {
    name: "New org",
    about:
      "The org connected GitHub during onboarding and nothing else. Hosted ctxpipe.",
    rows: [{ id: "con_gh", type: "github", displayName: "acme" }],
    facts: { deployment: "hosted", health: {} },
  },
  busyOrg: {
    name: "Busy org",
    about:
      "Eight connections on hosted ctxpipe: two Linear workspaces, a Notion setup that is not finished, and a PagerDuty account that needs a reconnect.",
    rows: [
      { id: "con_gh", type: "github", displayName: "acme" },
      { id: "con_cf", type: "forge", displayName: "acme.atlassian.net" },
      { id: "con_li1", type: "linear", displayName: "Acme Product" },
      { id: "con_li2", type: "linear", displayName: "Acme Platform" },
      { id: "con_no", type: "notion", displayName: "Acme" },
      { id: "con_sl", type: "slack", displayName: "Acme" },
      { id: "con_pd", type: "pagerduty", displayName: "Acme" },
      { id: "con_bk", type: "buildkite", displayName: "acme" },
    ],
    facts: {
      deployment: "hosted",
      health: { con_no: "setup_pending", con_pd: "reconnect" },
    },
  },
  selfHost: {
    name: "Self-host",
    about:
      "A self-hosted deployment with its own OAuth apps: Zendesk is available here, while hosted ctxpipe waits for Zendesk's approval.",
    rows: [
      { id: "con_gh", type: "github", displayName: "acme" },
      { id: "con_li1", type: "linear", displayName: "Acme Product" },
      { id: "con_pl", type: "plain", displayName: "Acme Support" },
    ],
    facts: { deployment: "self_host", health: {} },
  },
} satisfies Record<string, Scenario>
