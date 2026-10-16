import { delay, HttpResponse, http } from "msw"
import type {
  WorkspaceUpgradeItem,
  WorkspaceUpgrades,
} from "@/features/workspace-upgrades/queries"

function pathnameOf(request: Request) {
  return new URL(request.url).pathname
}

export function upgradeItemFixture(
  overrides: Partial<WorkspaceUpgradeItem> = {},
): WorkspaceUpgradeItem {
  return {
    key: "format-3",
    kind: "format",
    title: "Upgrade to format 3",
    status: "awaiting_operator",
    fromFormat: 0,
    targetFormat: 3,
    steps: [
      { format: 1, title: "Export and sources", commitSha: null, report: [] },
      {
        format: 2,
        title: "Move the context files",
        commitSha: null,
        report: [],
      },
      { format: 3, title: "Move the skills", commitSha: null, report: [] },
    ],
    pullRequest: null,
    estimate: null,
    repositories: [],
    blockedReason: null,
    note: null,
    failureReason: null,
    approvedBy: null,
    approvedAt: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  }
}

export function upgradesFixture(
  items: WorkspaceUpgradeItem[],
  overrides: Partial<Omit<WorkspaceUpgrades, "items">> = {},
): WorkspaceUpgrades {
  return { formatVersion: 0, codeFormat: 3, items, ...overrides }
}

/**
 * `GET /workspaces/:slug/upgrades`. `upgrades` is a value, a function (so a
 * story can change the answer after a click), "loading" or "error".
 * `workspaceSlug` limits the handler to one Workspace. Each answered read
 * adds its path to `answered`, so a play can wait for it.
 */
export function workspaceUpgradesHandler(
  upgrades: WorkspaceUpgrades | (() => WorkspaceUpgrades) | "loading" | "error",
  workspaceSlug?: string,
  answered?: string[],
) {
  return http.get(
    ({ request }) => {
      const path = pathnameOf(request)
      return workspaceSlug
        ? path.endsWith(`/workspaces/${workspaceSlug}/upgrades`)
        : /\/workspaces\/[^/]+\/upgrades$/.test(path)
    },
    async ({ request }) => {
      if (upgrades === "loading") await delay("infinite")
      answered?.push(pathnameOf(request))
      if (upgrades === "error")
        return HttpResponse.json({ error: "Server error" }, { status: 500 })
      return HttpResponse.json(
        typeof upgrades === "function" ? upgrades() : upgrades,
      )
    },
  )
}

/**
 * `POST /workspaces/:slug/upgrades/:key/start`. Each key goes to `requests`.
 * `answer` is the status of the reply: 202 queues, 409 refuses.
 */
export function workspaceUpgradeStartHandler(
  options: {
    requests?: string[]
    answer?: 202 | 409
    onStarted?: () => void
  } = {},
) {
  return http.post(
    ({ request }) =>
      /\/workspaces\/[^/]+\/upgrades\/[^/]+\/start$/.test(pathnameOf(request)),
    async ({ request }) => {
      options.requests?.push(pathnameOf(request))
      if (options.answer === 409)
        return HttpResponse.json(
          { error: "The upgrade is blocked" },
          { status: 409 },
        )
      options.onStarted?.()
      return HttpResponse.json(upgradeItemFixture({ status: "queued" }), {
        status: 202,
      })
    },
  )
}
