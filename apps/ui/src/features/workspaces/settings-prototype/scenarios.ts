/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). Story data for the
 * settings prototype. "Busy day" copies the shape of a real customer
 * Workspace on one day (its sources, run counts, stages, and times), with
 * made-up names: the repository is public, so no customer name goes here.
 */
import { delay, HttpResponse, http } from "msw"

import type { IngestionItem } from "@/features/workspaces/ingestion"
import type { WorkspaceDetail } from "@/features/workspaces/types"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceChangeHandlers,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradeAutomaticHandlers,
  workspaceUpgradeCheckHandler,
  workspaceUpgradesHandler,
  workspaceUpgradeStartHandler,
} from "@/mocks/workspace-upgrades-handlers"

export const ORG = "acme"
export const WS = "acme-ctxpipe-context"
const REPO = "https://github.com/acme/ctxpipe-context"
const BUSY_REPO = "acme/streaming-service"

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString()

export const prototypeWorkspace: WorkspaceDetail = {
  ...docsWorkspace,
  id: "ws_acme_context",
  slug: WS,
  displayName: "Acme/ctxpipe-context",
  workspaceRepositoryUrl: REPO,
  activeProjectionUrl: REPO,
  rootPath: "",
  writeStatus: "writable",
  readOnlyReason: null,
  hydrateStatus: "ready",
  hydrateError: null,
  conversationWritable: true,
  skippedFiles: [],
  linkedRepositories: [
    {
      id: "wlr_stream",
      workspaceId: "ws_acme_context",
      gitUrl: `https://github.com/${BUSY_REPO}`,
      desiredRef: "main",
      desiredSha: "9fa744a3",
      indexedSha: "9fa744a3",
      createdAt: "2026-10-19T09:00:00.000Z",
    },
    {
      id: "wlr_console",
      workspaceId: "ws_acme_context",
      gitUrl: "https://github.com/acme/web-console",
      desiredRef: "main",
      desiredSha: "b6800e29",
      indexedSha: "b6800e29",
      createdAt: "2026-10-19T09:00:00.000Z",
    },
  ],
}

// Upgrades
const formatDone = upgradeItemFixture({
  key: "format-3",
  kind: "format",
  status: "completed",
  fromFormat: 0,
  targetFormat: 3,
  pullRequest: { url: `${REPO}/pull/12`, number: 12 } as never,
  mergedAt: "2026-10-20T03:40:00.000Z",
  updatedAt: "2026-10-20T03:42:00.000Z",
})
const firstReingestDone = upgradeItemFixture({
  key: "reingest-v2-first",
  kind: "reingest",
  title: "Re-ingestion of the source repositories",
  status: "completed",
  fromFormat: 3,
  targetFormat: 3,
  steps: [],
  updatedAt: "2026-10-21T06:12:00.000Z",
  repositories: [
    {
      repository: BUSY_REPO,
      sha: "1c965f6c",
      runId: "run_r1",
      status: "done",
      report: [],
      spendUsd: 3.21,
      spendUnknown: false,
    },
    {
      repository: "acme/web-console",
      sha: "b6800e29",
      runId: "run_r2",
      status: "done",
      report: [],
      spendUsd: 0.92,
      spendUnknown: false,
    },
  ] as never,
})
/** 22 older re-ingestions, one each 3 days back from Oct 18: a long history. */
const olderReingests = Array.from({ length: 22 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 9, 18, 6, 10) - index * 3 * 86_400_000)
  return upgradeItemFixture({
    key: `reingest-old-${index}`,
    kind: "reingest",
    title: "Re-ingestion of the source repositories",
    status: "completed",
    fromFormat: 3,
    targetFormat: 3,
    steps: [],
    updatedAt: day.toISOString(),
    repositories: [
      {
        repository: BUSY_REPO,
        sha: "1c965f6c",
        runId: `run_old_${index}`,
        status: "done",
        report: [],
        spendUsd: 2.4 + (index % 5) * 0.37,
        spendUnknown: false,
      },
    ] as never,
  })
})
const reingestBase = {
  key: "reingest-skills-1027",
  kind: "reingest" as const,
  title: "Fresh re-ingestion of the source repositories",
  fromFormat: 3,
  targetFormat: 3,
  steps: [],
}
const reingestReady = upgradeItemFixture({
  ...reingestBase,
  status: "awaiting_operator",
  checkedAt: hoursAgo(0.4),
})
const reingestRunning = upgradeItemFixture({
  ...reingestBase,
  status: "running",
  approvedAt: hoursAgo(0.6),
  approvedBy: "user_owner",
  updatedAt: hoursAgo(0.6),
  repositories: [
    {
      repository: BUSY_REPO,
      sha: "9fa744a3",
      runId: "run_s1",
      status: "done",
      report: [],
      spendUsd: 1.84,
      spendUnknown: false,
    },
    {
      repository: "acme/web-console",
      sha: null,
      runId: "run_s2",
      status: "pending",
      report: [],
      spendUsd: null,
      spendUnknown: false,
    },
  ] as never,
})
const reingestFailed = upgradeItemFixture({
  ...reingestBase,
  status: "failed",
  failure: {
    code: "unknown",
    step: "publish",
    repository: BUSY_REPO,
    summary:
      "The publish of knowledge/services/streaming-service.md stopped: the file changed on the default branch, and the merge returned no result.",
  } as never,
  autoRetried: true,
  repositories: [
    {
      repository: BUSY_REPO,
      sha: "9fa744a3",
      runId: "run_f1",
      status: "failed",
      report: [],
      spendUsd: 2.07,
      spendUnknown: false,
    },
  ] as never,
})
const formatPrOpen = upgradeItemFixture({
  key: "format-3",
  kind: "format",
  status: "pr_open",
  fromFormat: 2,
  targetFormat: 3,
  pullRequest: { url: `${REPO}/pull/14`, number: 14 } as never,
})
const reingestBlockedOnFormat = upgradeItemFixture({
  ...reingestBase,
  status: "blocked",
  blockedReason: "needs_format",
})

// Running work: one repository gets a run for each push.
const busyRuns: IngestionItem[] = [
  ingestionItemFixture({
    id: "run_linear",
    kind: "source_sync",
    name: "Linear",
    stage: null,
    progress: null,
    minutesAgo: 136,
  }),
  ingestionItemFixture({
    id: "run_p1",
    name: BUSY_REPO,
    stage: "publishing",
    progress: null,
    minutesAgo: 142,
  }),
  ...[141, 86, 85].map((minutesAgo, index) =>
    ingestionItemFixture({
      id: `run_i${index}`,
      name: BUSY_REPO,
      stage: "ingesting",
      progress: { done: 1, total: 1, unit: "shards" },
      minutesAgo,
    }),
  ),
  ingestionItemFixture({
    id: "run_i3",
    name: BUSY_REPO,
    stage: "ingesting",
    progress: { done: 0, total: 1, unit: "shards" },
    minutesAgo: 83,
  }),
  ingestionItemFixture({
    id: "run_w1",
    name: BUSY_REPO,
    stage: "waiting",
    progress: null,
    minutesAgo: 49,
  }),
  ingestionItemFixture({
    id: "run_h1",
    kind: "hydrate",
    name: null,
    stage: null,
    progress: null,
    minutesAgo: 4,
  }),
]

const reingestRuns: IngestionItem[] = [
  ingestionItemFixture({
    id: "run_reingest",
    kind: "reingest",
    name: reingestBase.key,
    stage: null,
    progress: { done: 1, total: 2, unit: "repositories" },
    minutesAgo: 36,
  }),
  ingestionItemFixture({
    id: "run_s2",
    name: "acme/web-console",
    stage: "ingesting",
    progress: { done: 2, total: 5, unit: "shards" },
    minutesAgo: 11,
  }),
]

// Sources
const sources = workspaceSourceList({
  items: [
    workspaceSourceFixture({
      path: "sources/github/acme/streaming-service.md",
      provider: "github",
      connectionId: "con_gh",
      connectionName: "acme",
      scope: { repository: BUSY_REPO },
      scopeSummary: BUSY_REPO,
    }),
    workspaceSourceFixture({
      path: "sources/github/acme/web-console.md",
      provider: "github",
      connectionId: "con_gh",
      connectionName: "acme",
      scope: { repository: "acme/web-console" },
      scopeSummary: "acme/web-console",
    }),
    workspaceSourceFixture({
      path: "sources/linear/eng.md",
      provider: "linear",
      connectionId: "con_li",
      connectionName: "Acme Linear",
      scope: { teams: ["ENG", "PLAT"] },
      scopeSummary: "2 teams",
    }),
  ],
})

/** Accepts each settings save, so a variant can show its saved state. */
const writeHandlers = (detail: WorkspaceDetail) => [
  http.patch(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+$/.test(new URL(request.url).pathname),
    async ({ request }) => {
      await delay(400)
      const body = (await request.json()) as Partial<WorkspaceDetail>
      return HttpResponse.json({ ...detail, ...body })
    },
  ),
  http.post(
    ({ request }) =>
      new URL(request.url).pathname.endsWith("/check-write-access"),
    async () => {
      await delay(600)
      return HttpResponse.json(detail)
    },
  ),
]

export type Scenario = {
  /** The story name. */
  name: string
  /** What the scenario shows, in one line. */
  about: string
  detail: WorkspaceDetail
  upgrades: Parameters<typeof upgradesFixture>[0] | "loading" | "error"
  formatVersion?: number
  runs: IngestionItem[]
  sources?: ReturnType<typeof workspaceSourceList> | "loading" | "error"
  role?: "owner" | "member"
  automatic?: "manual" | "automatic"
}

/**
 * The msw groups of a scenario. The preview sets `ingestion` to "nothing
 * runs", so a scenario must set that same key to replace it.
 */
export function scenarioMsw(scenario: Scenario) {
  return {
    ingestion: workspaceIngestionHandlers({ [WS]: scenario.runs }),
    page: scenarioHandlers(scenario),
  }
}

function scenarioHandlers(scenario: Scenario) {
  const upgrades =
    scenario.upgrades === "loading" || scenario.upgrades === "error"
      ? scenario.upgrades
      : upgradesFixture(scenario.upgrades, {
          formatVersion: scenario.formatVersion ?? 3,
        })
  return [
    activeMemberRoleHandler(scenario.role ?? "owner"),
    workspaceUpgradesHandler(upgrades),
    workspaceUpgradeStartHandler(),
    workspaceUpgradeCheckHandler(),
    ...workspaceUpgradeAutomaticHandlers({
      setting: { mode: scenario.automatic ?? "manual" },
    }),
    workspaceSourcesHandler(scenario.sources ?? sources),
    ...workspaceSourceChangeHandlers(),
    orgConnectionsHandler([
      { id: "con_gh", type: "github", displayName: "acme" },
      { id: "con_li", type: "linear", displayName: "Acme Linear" },
    ]),
    ...writeHandlers(scenario.detail),
    ...workspaceShellHandlers({
      workspaces: [scenario.detail],
      detail: scenario.detail,
    }),
  ]
}

export const scenarios = {
  busyDay: {
    name: "Busy day",
    about:
      "The shape of a real Workspace on one day: a paid re-ingestion waits for you, one repository has 6 runs (one for each push), a daily Linear sync shows as running, and the newest commit is indexing.",
    detail: prototypeWorkspace,
    upgrades: [reingestReady, formatDone, firstReingestDone],
    runs: busyRuns,
  },
  upToDate: {
    name: "Up to date",
    about: "Nothing runs and nothing needs you.",
    detail: prototypeWorkspace,
    upgrades: [formatDone, firstReingestDone],
    runs: [],
  },
  reingestRunning: {
    name: "Re-ingestion running",
    about:
      "A paid re-ingestion runs: 1 of 2 repositories done, with the spend so far.",
    detail: prototypeWorkspace,
    upgrades: [reingestRunning, formatDone, firstReingestDone],
    runs: reingestRuns,
  },
  mergePullRequest: {
    name: "Pull request to merge",
    about:
      "A format upgrade opened pull request #14. The re-ingestion waits for it.",
    detail: prototypeWorkspace,
    upgrades: [formatPrOpen, reingestBlockedOnFormat],
    formatVersion: 2,
    runs: [],
  },
  upgradeFailed: {
    name: "Upgrade failed",
    about:
      "The re-ingestion failed at the publish step, after one automatic retry. The agent can help.",
    detail: prototypeWorkspace,
    upgrades: [reingestFailed, formatDone, firstReingestDone],
    runs: [],
  },
  readOnly: {
    name: "Read-only",
    about: "The GitHub App cannot push to the Workspace repository.",
    detail: {
      ...prototypeWorkspace,
      writeStatus: "read_only",
      conversationWritable: false,
      readOnlyReason:
        "The GitHub App of acme cannot push to acme/ctxpipe-context. Give it Contents: Read and write.",
    },
    upgrades: [formatDone, firstReingestDone],
    runs: [],
  },
  changesByPullRequest: {
    name: "Changes by pull request",
    about:
      "The default branch is protected: a conversation pushes its own branch and opens a pull request. A normal state.",
    detail: {
      ...prototypeWorkspace,
      writeStatus: "read_only",
      conversationWritable: true,
      readOnlyReason: "The default branch main is protected.",
    },
    upgrades: [formatDone, firstReingestDone],
    runs: [],
  },
  writeCheckFailed: {
    name: "Write check failed",
    about: "GitHub returned an error, so ctxpipe could not check write access.",
    detail: {
      ...prototypeWorkspace,
      writeStatus: "unknown",
      readOnlyReason:
        "ctxpipe could not check write access because GitHub returned an error or a rate limit. Check again later.",
    },
    upgrades: [formatDone, firstReingestDone],
    runs: [],
  },
  graphProblems: {
    name: "Graph problems",
    about:
      "The graph did not load, and 2 knowledge files were skipped. One file can be fixed with the agent.",
    detail: {
      ...prototypeWorkspace,
      hydrateStatus: "failed",
      hydrateError:
        "The graph database refused the write. ctxpipe tries again with the next commit.",
      skippedFiles: [
        {
          path: "knowledge/apis/imported.md",
          reason: "malformed",
          source: "legacy-overlay",
        },
        { path: "knowledge/billing/tax.md", reason: "malformed" },
      ] as never,
    },
    upgrades: [formatDone, firstReingestDone],
    runs: [],
  },
  repositoryMoving: {
    name: "Repository moving",
    about:
      "The Workspace moved to a new repository, in a folder. Answers come from the old one until it loads.",
    detail: {
      ...prototypeWorkspace,
      workspaceRepositoryUrl: "https://github.com/acme/platform-docs",
      rootPath: "context",
      activeProjectionUrl: REPO,
      hydrateStatus: "running",
    },
    upgrades: [formatDone, firstReingestDone],
    runs: [
      ingestionItemFixture({
        id: "run_h2",
        kind: "hydrate",
        name: null,
        stage: null,
        progress: null,
        minutesAgo: 2,
      }),
    ],
  },
  longHistory: {
    name: "Long history",
    about:
      "A Workspace with 24 applied upgrades: the history shows the 5 newest, and the rest open in a scroll area.",
    detail: prototypeWorkspace,
    upgrades: [reingestReady, formatDone, firstReingestDone, ...olderReingests],
    runs: busyRuns,
  },
  memberView: {
    name: "Member view",
    about:
      'The busy day for a member: "Ask an admin" in place of Start, and the automatic upgrades switch is locked.',
    detail: prototypeWorkspace,
    upgrades: [reingestReady, formatDone, firstReingestDone],
    runs: busyRuns,
    role: "member",
  },
  loading: {
    name: "Loading",
    about: "The upgrades and the sources are still loading.",
    detail: prototypeWorkspace,
    upgrades: "loading",
    runs: [],
    sources: "loading",
  },
  loadErrors: {
    name: "Load errors",
    about: "The upgrades and the sources could not load.",
    detail: prototypeWorkspace,
    upgrades: "error",
    runs: [],
    sources: "error",
  },
} satisfies Record<string, Scenario>
