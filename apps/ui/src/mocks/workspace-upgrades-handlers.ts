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
    // The descriptions of the backend registry.
    description:
      overrides.kind === "reingest"
        ? "Ingests each source repository again with the new ingestion and publishes the new knowledge files under knowledge/. This uses model calls, so it costs money."
        : "Moves the repository links from repositories/ into .ctxpipe/sources.yaml, and writes the old knowledge that a new ingestion cannot make again into files under knowledge/.",
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
    waitingForSlot: null,
    failureReason: null,
    failure: null,
    autoRetried: false,
    runStage: null,
    mergedAt: null,
    checkedAt: null,
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

/** `POST /workspaces/:slug/upgrades/check`. Each call adds its path to `requests`. */
export function workspaceUpgradeCheckHandler(
  options: { requests?: string[]; onChecked?: () => void } = {},
) {
  return http.post(
    ({ request }) =>
      /\/workspaces\/[^/]+\/upgrades\/check$/.test(pathnameOf(request)),
    ({ request }) => {
      options.requests?.push(pathnameOf(request))
      options.onChecked?.()
      return HttpResponse.json({ queued: true }, { status: 202 })
    },
  )
}

/**
 * `GET /workspace-upgrades/pending`: the pending upgrades of the org, keyed
 * by Workspace slug. `formats` gives the format of a Workspace (default: the
 * newest). As the server does, a Workspace below the newest format is in the
 * list also with no item, and a Workspace at the newest format with no item
 * is left out. `"error"` answers 500. Each answered read adds its path to
 * `answered`.
 */
export function pendingWorkspaceUpgradesHandler(
  bySlug: Record<string, WorkspaceUpgradeItem[]>,
  answered?: string[],
  options: {
    formats?: Record<string, number | null>
    answer?: "error"
  } = {},
) {
  const codeFormat = 3
  return http.get(
    ({ request }) =>
      pathnameOf(request).endsWith("/workspace-upgrades/pending"),
    ({ request }) => {
      answered?.push(pathnameOf(request))
      if (options.answer === "error")
        return HttpResponse.json({ error: "Server error" }, { status: 500 })
      const slugs = new Set([
        ...Object.keys(bySlug),
        ...Object.keys(options.formats ?? {}),
      ])
      return HttpResponse.json({
        workspaces: [...slugs]
          .map((workspaceSlug) => ({
            workspaceSlug,
            formatVersion: options.formats?.[workspaceSlug] ?? codeFormat,
            codeFormat,
            items: (bySlug[workspaceSlug] ?? []).filter(
              (item) => item.status !== "completed",
            ),
          }))
          .filter(
            (workspace) =>
              workspace.items.length > 0 ||
              (workspace.formatVersion !== null &&
                workspace.formatVersion >= 0 &&
                workspace.formatVersion < codeFormat),
          ),
      })
    },
  )
}

/**
 * The automatic-upgrades setting: `GET` and `POST
 * /workspaces/:slug/upgrades/automatic`, and the read of the file job of a
 * save. The job completes at once, or answers `job` (for example `running`
 * for a slow save, or `failed` with its cause). `setting` holds the mode and
 * the reason that the GET answers: a completed save changes the mode. Each call adds its
 * method and path to `requests` ("POST <path> <mode>" for a save), so a play
 * can check the calls.
 */
export function workspaceUpgradeAutomaticHandlers(
  options: {
    requests?: string[]
    job?: { status: string; failureReason: string | null }
    setting?: {
      mode: "manual" | "automatic" | null
      reason?: "no_tip" | "invalid_format" | "unreadable" | null
    }
  } = {},
) {
  const isSetting = ({ request }: { request: Request }) =>
    /\/workspaces\/[^/]+\/upgrades\/automatic$/.test(pathnameOf(request))
  return [
    http.get(isSetting, () =>
      HttpResponse.json({
        mode: options.setting ? options.setting.mode : "manual",
        reason: options.setting?.reason ?? null,
      }),
    ),
    http.post(isSetting, async ({ request }) => {
      const { mode } = (await request.json()) as {
        mode: "manual" | "automatic"
      }
      options.requests?.push(`POST ${pathnameOf(request)} ${mode}`)
      if (
        options.setting &&
        (options.job?.status ?? "completed") === "completed"
      )
        options.setting.mode = mode
      return HttpResponse.json(
        { queued: true, jobId: "wjob_automatic" },
        { status: 202 },
      )
    }),
    http.get(
      ({ request }) =>
        /\/workspaces\/[^/]+\/files\/jobs\/wjob_automatic$/.test(
          pathnameOf(request),
        ),
      ({ request }) => {
        options.requests?.push(pathnameOf(request))
        return HttpResponse.json(
          options.job ?? { status: "completed", failureReason: null },
        )
      },
    ),
  ]
}
