import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { OrgDashboardPage } from "@/features/dashboard/OrgDashboardPage"
import { githubInstallationNoneHandler } from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"

const emptyConnectors = {
  status: "ok" as const,
  github: { total: 0, installed: 0, needsSetup: 0 },
  forge: { total: 0, installed: 0, running: 0, failed: 0 },
  linear: { total: 0, ready: 0, needsSetup: 0, failed: 0 },
  notion: { total: 0, ready: 0, needsSetup: 0, failed: 0 },
}

function dashboardSummaryHandler(body: Record<string, unknown>) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname === "/acme/api/v1/dashboard/summary",
    () => HttpResponse.json(body),
  )
}

const emptySummary = {
  health: {
    overall: "warning",
    repositories: {
      status: "warning",
      total: 0,
      indexed: 0,
      indexing: 0,
      notReady: 0,
    },
    graph: {
      status: "unknown",
      totalNodes: null,
      totalEdges: null,
      entityTypes: null,
      relationshipTypes: null,
      isolatedNodes: null,
      averageDegree: null,
      lastObservedAt: null,
      computedAt: null,
    },
    connectors: emptyConnectors,
    confluence: {
      status: "ok",
      syncTargets: 0,
      enabledTargets: 0,
      spaces: 0,
      lastSyncedAt: null,
    },
    evidence: {
      status: "warning",
      activeClaims: 0,
      lowConfidenceClaims: 0,
      contextConfidence: null,
      confidenceSeries: [],
      freshnessSeries: [],
      instructionUnits: 0,
      lastObservedAt: null,
      computedAt: null,
      freshness: { lt24h: 0, lt7d: 0, lt30d: 0, gt30d: 0 },
    },
  },
  actions: [
    {
      severity: "warning",
      title: "No repositories are connected",
      detail: "Add a repository so ctxpipe can build search and graph context.",
      href: "/acme/repositories",
    },
  ],
  activity: { range: "30d", buckets: [], members: null },
}

const populatedSummary = {
  health: {
    overall: "warning",
    repositories: {
      status: "ok",
      total: 4,
      indexed: 4,
      indexing: 0,
      notReady: 0,
    },
    graph: {
      status: "ok",
      totalNodes: 1280,
      totalEdges: 3400,
      entityTypes: 12,
      relationshipTypes: 18,
      isolatedNodes: 4,
      averageDegree: 5.3,
      lastObservedAt: "2026-08-16T09:00:00.000Z",
      computedAt: "2026-08-16T09:00:00.000Z",
    },
    connectors: {
      status: "warning",
      github: { total: 1, installed: 1, needsSetup: 0 },
      forge: { total: 1, installed: 1, running: 0, failed: 0 },
      linear: { total: 1, ready: 0, needsSetup: 1, failed: 0 },
      notion: { total: 1, ready: 1, needsSetup: 0, failed: 0 },
    },
    confluence: {
      status: "ok",
      syncTargets: 1,
      enabledTargets: 1,
      spaces: 6,
      lastSyncedAt: "2026-08-16T08:30:00.000Z",
    },
    evidence: {
      status: "ok",
      activeClaims: 240,
      lowConfidenceClaims: 0,
      contextConfidence: 0.86,
      confidenceSeries: [
        { date: "2026-08-10", value: 0.81 },
        { date: "2026-08-16", value: 0.86 },
      ],
      freshnessSeries: [
        { date: "2026-08-10", value: 0.72 },
        { date: "2026-08-16", value: 0.8 },
      ],
      instructionUnits: 40,
      lastObservedAt: "2026-08-16T08:30:00.000Z",
      computedAt: "2026-08-16T09:00:00.000Z",
      freshness: { lt24h: 80, lt7d: 110, lt30d: 40, gt30d: 10 },
    },
  },
  actions: [
    {
      severity: "warning",
      title: "Linear setup is incomplete",
      detail:
        "Finish scope and the config pull request so issues stay in context.",
      href: "/acme/connectors",
    },
  ],
  activity: { range: "30d", buckets: [], members: null },
}

const meta = {
  title: "Pages/Dashboard",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Start: Story = {
  render: () => <OrgDashboardPage orgSlug="acme" />,
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          githubInstallationNoneHandler,
          dashboardSummaryHandler(emptySummary),
        ],
      },
    },
  },
}

export const ConnectorsPopulated: Story = {
  render: () => <OrgDashboardPage orgSlug="acme" />,
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [dashboardSummaryHandler(populatedSummary)],
      },
    },
  },
}
