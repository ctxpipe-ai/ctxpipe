import { HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"

import type { WorkspaceSkippedFile } from "@/features/workspaces/types"
import {
  docsWorkspace,
  docsWorkspaceDetail,
  legacyOverlaySkippedFile,
} from "@/features/workspaces/workspace-fixtures"
import {
  githubInstallationLinkedHandler,
  signedInHandlers,
} from "@/mocks/handlers"
import { setupGuideHandlers } from "@/mocks/setup-guide-handlers"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"
import { orgConnectionsHandler } from "@/mocks/workspace-sources-handlers"
import {
  pendingWorkspaceUpgradesHandler,
  upgradeItemFixture,
  workspaceUpgradeAutomaticHandlers,
  workspaceUpgradeStartHandler,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import preview from "../../.storybook/preview"
import { OrgHomePageContent } from "./$orgSlug.index"

const handbook = {
  ...docsWorkspace,
  id: "ws_handbook",
  slug: "handbook",
  displayName: "Handbook",
}

const answered: string[] = []
const perWorkspaceReads: string[] = []
const requests: string[] = []

const meta = preview.meta({
  title: "Pages/Home/Notices",
  tags: ["page"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, ...workspaceIngestionHandlers({}))

    answered.length = 0
    perWorkspaceReads.length = 0
    requests.length = 0
    // A dismissed toast of an earlier story must not hide a toast here.
    window.localStorage.removeItem("ctxpipe:userPreferences")
  },
  parameters: {
    app: "org",
    layout: "fullscreen",
    review: { kind: "page" },
    route: "/$orgSlug/",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
})

const reingest = upgradeItemFixture({
  key: "reingest-bundle-2",
  kind: "reingest",
  title: "Fresh re-ingestion of the source repositories",
  description:
    "Ingests each source repository again with the new ingestion and publishes the new knowledge files under knowledge/. This uses model calls, so it costs money.",
  steps: [],
})

function homeHandlers(
  role: string,
  items: Parameters<typeof pendingWorkspaceUpgradesHandler>[0],
  options: {
    skippedFiles?: Record<string, WorkspaceSkippedFile[]>
    automaticJob?: { status: string; failureReason: string | null }
    /** Runs when the start request succeeds, so the pending items can change. */
    onStarted?: () => void
  } = {},
) {
  const { skippedFiles = {}, automaticJob, onStarted } = options
  return [
    pendingWorkspaceUpgradesHandler(items, answered),
    // The setup guide reads of the org: GitHub is linked and connected.
    ...setupGuideHandlers({
      role,
      github: githubInstallationLinkedHandler,
      connectors: orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
    }),
    // The detail of each Workspace, with its skipped files.
    http.get(/\/api\/v1\/workspaces\/([^/]+)$/, ({ request }) => {
      const slug = new URL(request.url).pathname.split("/").pop() ?? ""
      const workspace = [docsWorkspace, handbook].find(
        (entry) => entry.slug === slug,
      )
      if (!workspace)
        return HttpResponse.json({ error: "not found" }, { status: 404 })
      return HttpResponse.json({
        ...docsWorkspaceDetail,
        ...workspace,
        skippedFiles: skippedFiles[slug] ?? [],
      })
    }),
    workspaceUpgradeStartHandler({ requests, onStarted }),
    ...workspaceUpgradeAutomaticHandlers({
      requests,
      ...(automaticJob ? { job: automaticJob } : {}),
    }),
    // The home reads the org once. A read of one Workspace fails the story.
    http.get(/\/workspaces\/[^/]+\/upgrades$/, () => {
      perWorkspaceReads.push("upgrades")
      return HttpResponse.json({ error: "Not expected" }, { status: 500 })
    }),
    ...workspaceShellHandlers({ workspaces: [docsWorkspace, handbook] }),
  ]
}

const threeItems = {
  docs: [upgradeItemFixture(), reingest],
  handbook: [upgradeItemFixture()],
}

/**
 * Waits for the first load of the notice stack, until it holds `count`
 * toasts, and returns it. Each play starts with this wait. Upgrade toasts
 * come from the org read. Problem toasts come from the detail read of each
 * Workspace, which waits for the Workspace list. Then a render and a view
 * transition show the stack. All of these reads start when the play starts.
 * With the default bound of 1 s, ProblemLegacyOverlayAndFile and
 * ProblemLegacyOverlayOnly failed once on mobile in a factory check on a
 * shared host, where one capture container got less than 1 CPU (CTX-1498).
 * In a capture container with 1 CPU, a problem story got its stack after
 * 0.5 s; with 0.25 CPU after 2 s, and with 0.1 CPU after 4.8 s. The bound
 * is about 2x the time at 0.1 CPU, and much less than the 120 s that the
 * runner gives each story. It is a ceiling, not a delay: the wait ends when
 * the stack is full.
 */
async function findNotices(canvasElement: HTMLElement, count: number) {
  await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(count), {
    timeout: 10_000,
  })
  return within(canvasElement).getByRole("region", {
    name: "Workspace notices",
  })
}

/** The toasts of the stack, front first. */
function toastItems(canvasElement: HTMLElement) {
  const region = within(canvasElement).getByRole("region", {
    name: "Workspace notices",
  })
  return within(region).getAllByRole("listitem")
}

/** The title of the front toast. Two toasts of one Workspace share a title. */
function frontTitle(canvasElement: HTMLElement) {
  const [front] = toastItems(canvasElement)
  if (!front) throw new Error("No toast")
  return within(front).getByText("Docs upgrade available")
}

/**
 * Org home page with upgrade and problem notices as toasts: one toast for the
 * one Workspace upgrade that waits for a start, with Update once, Always update
 * and Dismiss. The play proves one read for the org and no read for each
 * Workspace.
 */
export const SingleToast = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers("owner", {
        docs: [upgradeItemFixture()],
        handbook: [upgradeItemFixture({ status: "completed" })],
      }),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await findNotices(canvasElement, 1)
    await waitFor(() =>
      expect(within(region).getByText("Docs upgrade available")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        within(region).getByText(
          "ctxpipe opens a pull request for format 3. Nothing changes until you merge it.",
        ),
      ).toBeVisible(),
    )
    // One short line: the full description stays in Workspace settings.
    expect(within(region).queryByText(/sources\.yaml/)).toBeNull()
    for (const name of ["Update once", "Always update", "Dismiss"])
      await waitFor(() =>
        expect(
          within(region).getByRole("button", {
            name: `${name}: Docs, Upgrade to format 3`,
          }),
        ).toBeVisible(),
      )
    expect(toastItems(canvasElement)).toHaveLength(1)
    expect(canvas.queryByText(/Handbook upgrade/)).toBeNull()
    // One read for the org, and no read for each Workspace.
    expect(answered).not.toHaveLength(0)
    expect(perWorkspaceReads).toEqual([])
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: the user dismissed
 * the toast, and the composer moved back up with no gap. The toast is a title
 * and one short line, so it does not cover the composer (CTX-939).
 */
export const ToastTakesNoSpaceAfterItGoes = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("owner", { docs: [upgradeItemFixture()] }))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await findNotices(canvasElement, 1)
    await document.fonts.ready
    const composerTop = () =>
      canvas
        .getByRole("button", { name: "Select workspace" })
        .getBoundingClientRect().top
    await waitFor(() =>
      expect(within(region).getByText("Docs upgrade available")).toBeVisible(),
    )
    const toast = region.getBoundingClientRect()
    // The toast ends above the composer, and its text is short.
    expect(toast.bottom).toBeLessThanOrEqual(composerTop())
    expect(region.textContent?.split(/\s+/).length ?? 0).toBeLessThan(40)
    const before = composerTop()
    await userEvent.click(
      within(region).getByRole("button", {
        name: "Dismiss: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Workspace notices" }),
      ).toBeNull(),
    )
    // The view transition ends, and the layout holds no gap.
    await waitFor(() =>
      expect(composerTop()).toBeLessThanOrEqual(before - toast.height),
    )
  },
})

/** The pending items of UpdateOnce: the start queues the item. */
const updateOnceItems = { docs: [upgradeItemFixture()] }

/**
 * Home with an upgrade toast: the owner pressed Update once, so the upgrade is
 * queued, the toast went away, and a message says that ctxpipe prepares a pull
 * request. Update once uses the existing start API.
 */
export const UpdateOnce = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers("owner", updateOnceItems, {
        onStarted: () => {
          updateOnceItems.docs = [upgradeItemFixture({ status: "queued" })]
        },
      }),
    )

    updateOnceItems.docs = [upgradeItemFixture()]
  },
  decorators: [
    (Story) => (
      <>
        <Story />
        {/* The props of the Toaster of the app root. The toast stays: its
            4 s timer ran out before the shot of a slow capture (CTX-1498). */}
        <Toaster richColors position="top-center" duration={Infinity} />
      </>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 1)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Update once: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(requests).toEqual([
        "/acme/api/v1/workspaces/docs/upgrades/format-3/start",
      ]),
    )
    const body = within(canvasElement.ownerDocument.body)
    await body.findByText(
      "The upgrade is queued. ctxpipe prepares a pull request.",
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Workspace notices" }),
      ).toBeNull(),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: the owner pressed
 * Always update, and the toast shows the progress of the save. The server saves
 * the setting and starts the upgrade, so the browser sends no start request.
 */
export const AlwaysUpdate = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("owner", { docs: [upgradeItemFixture()] }))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 1)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Always update: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(
          "ctxpipe saved the setting. The upgrade starts in a moment.",
        ),
      ).toBeVisible(),
    )
    expect(requests).toEqual([
      "POST /acme/api/v1/workspaces/docs/upgrades/automatic automatic",
      "/acme/api/v1/workspaces/docs/files/jobs/wjob_automatic",
    ])
    expect(requests.some((path) => path.endsWith("/start"))).toBe(false)
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: the Always update
 * save is slow, so the toast says that the server saves and starts the upgrade.
 * The other buttons stay usable, and Dismiss still works.
 */
export const AlwaysUpdateSlowSave = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers(
        "owner",
        { docs: [upgradeItemFixture()] },
        { automaticJob: { status: "running", failureReason: null } },
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 1)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Always update: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/ctxpipe saves the setting\. It starts the upgrade/),
      ).toBeVisible(),
    )
    expect(canvas.getByText(/You can leave this page/)).toBeVisible()
    // The save runs on the server: nothing starts in the browser.
    expect(requests.some((path) => path.endsWith("/start"))).toBe(false)
  },
})

/**
 * Home with an upgrade toast: the owner pressed Always update and the setting
 * did not save, so the toast gives the next steps and the cause as raw error
 * text. Update once stays available.
 */
export const AlwaysUpdateSaveFails = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers(
        "owner",
        { docs: [upgradeItemFixture()] },
        {
          automaticJob: {
            status: "failed",
            failureReason:
              "The write stopped before it finished. stdout maxBuffer length exceeded",
          },
        },
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 1)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Always update: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/ctxpipe could not save the setting\./),
      ).toBeVisible(),
    )
    expect(canvas.getByText(/stdout maxBuffer length exceeded/)).toBeVisible()
    expect(
      canvas.getByRole("link", {
        name: "Review upgrade: Docs, Upgrade to format 3",
      }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
    // Update once is still a way to go on.
    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "Update once: Docs, Upgrade to format 3",
        }),
      ).toBeEnabled(),
    )
  },
})

// The server names this Git error a known cause: the repository is too large.
const failedUpgrade = upgradeItemFixture({
  status: "failed",
  failureReason: "stdout maxBuffer length exceeded",
  failure: {
    code: "repository_too_large",
    step: null,
    repository: null,
    summary: "stdout maxBuffer length exceeded",
  },
})

/**
 * Home with a toast for a failed Workspace upgrade: the owner pressed Ask the
 * agent, so the composer of that Workspace holds a prompt with the cause. The
 * cause can repeat, so the toast offers no Update once and no Always update.
 */
export const FailedUpgrade = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("owner", { docs: [failedUpgrade] }))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await findNotices(canvasElement, 1)
    await waitFor(() =>
      expect(within(region).getByText("Docs upgrade failed")).toBeVisible(),
    )
    expect(within(region).getByText(/maxBuffer length exceeded/)).toBeVisible()
    expect(
      within(region).queryByRole("button", { name: /Update once/ }),
    ).toBeNull()
    expect(
      within(region).queryByRole("button", { name: /Always update/ }),
    ).toBeNull()
    expect(
      within(region).getByRole("link", {
        name: "Review upgrade: Docs, Upgrade to format 3",
      }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
    await userEvent.click(
      within(region).getByRole("button", {
        name: "Ask the agent: Docs, Upgrade to format 3",
      }),
    )
    const composer = () =>
      canvas.getByPlaceholderText(/what should ctxpipe do in this workspace/i)
    await waitFor(() =>
      expect((composer() as HTMLTextAreaElement).value).toContain(
        'The upgrade "Upgrade to format 3" of this Workspace failed',
      ),
    )
    expect(requests).toEqual([])
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: an upgrade failed,
 * and a member also sees the cause, Ask the agent and the review link. The
 * toast offers no Update once.
 */
export const FailedUpgradeMember = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("member", { docs: [failedUpgrade] }))
  },
  play: async ({ canvasElement }) => {
    const region = await findNotices(canvasElement, 1)
    await waitFor(() =>
      expect(within(region).getByText("Docs upgrade failed")).toBeVisible(),
    )
    expect(
      within(region).getByRole("button", {
        name: "Ask the agent: Docs, Upgrade to format 3",
      }),
    ).toBeVisible()
    expect(
      within(region).queryByRole("button", { name: /Update once/ }),
    ).toBeNull()
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: the user dismissed
 * the toast in this browser and nothing started. The toast collapses to an
 * upgrade icon with a count, and a press on it shows the toast again.
 */
export const Dismiss = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("owner", { docs: [upgradeItemFixture()] }))
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as UpdateOnce." },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 1)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Dismiss: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Workspace notices" }),
      ).toBeNull(),
    )
    expect(requests).toEqual([])
    expect(window.localStorage.getItem("ctxpipe:userPreferences")).toContain(
      "acme/docs/format-3/awaiting_operator",
    )
    // The dismissed toast collapses to the upgrade icon with its count.
    const show = await canvas.findByRole("button", {
      name: "Show notices: 1 upgrade",
    })
    expect(show.textContent).toBe("1")
    await userEvent.click(show)
    await waitFor(() =>
      expect(canvas.getByText("Docs upgrade available")).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: /Show notices/ })).toBeNull(),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: the user dismissed
 * two toasts, so they collapsed to one icon with a count, and then pressed the
 * icon. All three toasts are back in the stack.
 */
export const DismissedCollapseToIcon = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("owner", threeItems))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 3)
    // No toast is dismissed yet, so there is no icon.
    expect(canvas.queryByRole("button", { name: /Show notices/ })).toBeNull()
    for (const name of [
      "Dismiss: Docs, Upgrade to format 3",
      "Dismiss: Docs, Fresh re-ingestion of the source repositories",
    ]) {
      await userEvent.click(await canvas.findByRole("button", { name }))
      await waitFor(() =>
        expect(canvas.queryByRole("button", { name })).toBeNull(),
      )
    }
    // The stack animates after each dismiss. Query again on each try, and
    // wait for each state that the play checks.
    const showName = "Show notices: 2 upgrades"
    await waitFor(() => {
      const show = canvas.getByRole("button", { name: showName })
      expect(show).toBeVisible()
      expect(show.textContent).toBe("2")
    })
    // The Handbook toast stays in the stack.
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).toBeVisible(),
    )
    await userEvent.click(canvas.getByRole("button", { name: showName }))
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(3))
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: /Show notices/ })).toBeNull(),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: three toasts in one
 * stack, where only the front toast shows and the others are edges behind it.
 * The pointer opens the stack, and here Tab moved the focus to a toast behind
 * the front one, so the stack is open.
 */
export const StackOfThree = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("owner", threeItems))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 3)
    await waitFor(() => expect(frontTitle(canvasElement)).toBeVisible())
    // Closed: the toasts behind the front one hide their text.
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).not.toBeVisible(),
    )
    await document.fonts.ready
    await userEvent.hover(frontTitle(canvasElement))
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).toBeVisible(),
    )
    // Open: each toast sits below the one in front of it, with no overlap.
    await waitFor(() => {
      const [front, second, third] = toastItems(canvasElement).map((item) =>
        item.getBoundingClientRect(),
      )
      expect(second?.top).toBeGreaterThanOrEqual(front?.bottom ?? 0)
      expect(third?.top).toBeGreaterThanOrEqual(second?.bottom ?? 0)
    })
    await userEvent.unhover(frontTitle(canvasElement))
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).not.toBeVisible(),
    )
    // The keyboard reaches a toast behind the front one, and focus opens it.
    canvas
      .getByRole("button", { name: "Dismiss: Docs, Upgrade to format 3" })
      .focus()
    await userEvent.tab()
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Update once: Docs, Fresh re-ingestion of the source repositories",
      ),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(
          "ctxpipe reads each source repository again. This uses model calls.",
        ),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).toBeVisible(),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: a member sees the
 * toasts with the quiet line "Ask an admin" and no button.
 */
export const MemberView = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("member", threeItems))
  },
  play: async ({ canvasElement }) => {
    const region = await findNotices(canvasElement, 3)
    await waitFor(() =>
      expect(within(region).getAllByText("Ask an admin")[0]).toBeVisible(),
    )
    await waitFor(() =>
      expect(within(region).queryAllByRole("button")).toHaveLength(0),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: the user prefers
 * reduced motion, and the pointer opened the stack with no transition.
 */
export const ReducedMotion = meta.story({
  tags: ["reduced-motion"],
  beforeEach: ({ msw }) => {
    msw.use(...homeHandlers("owner", threeItems))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 3)
    for (const item of toastItems(canvasElement))
      expect(
        Number.parseFloat(getComputedStyle(item).transitionDuration),
      ).toBeLessThan(0.001)
    await userEvent.hover(frontTitle(canvasElement))
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).toBeVisible(),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: no item can start
 * now (it is running, has an open pull request, or is blocked), so no toast
 * shows.
 */
export const NoToastWhenNothingToStart = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers("owner", {
        docs: [
          upgradeItemFixture({ status: "running" }),
          { ...reingest, status: "blocked", blockedReason: "needs_format" },
        ],
        handbook: [upgradeItemFixture({ status: "pr_open" })],
      }),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as the Populated story of the Home page.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Activity")).toBeVisible(),
    )
    // The read must be answered before the check, or it passes too early.
    await waitFor(() => expect(answered).not.toHaveLength(0))
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Workspace notices" }),
      ).toBeNull(),
    )
  },
})

const taxFile: WorkspaceSkippedFile = {
  path: "knowledge/billing/tax.md",
  reason: "malformed",
}

/**
 * Org home page with upgrade and problem notices as toasts: a hydrate problem
 * shows as a warning toast, with no upgrade. The user pressed Fix using agent,
 * so the composer of that Workspace holds the fix prompt, and the problem
 * stays.
 */
export const ProblemOnly = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers("owner", {}, { skippedFiles: { handbook: [taxFile] } }),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await findNotices(canvasElement, 1)
    await waitFor(() =>
      expect(
        within(region).getByText("Handbook: hydrate skipped 1 file"),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        within(region).getByText(/Front matter is not valid/),
      ).toBeVisible(),
    )
    expect(toastItems(canvasElement)).toHaveLength(1)
    await userEvent.click(
      within(region).getByRole("button", {
        name: "Fix using agent: Handbook, skipped files",
      }),
    )
    const composer = () =>
      canvas.getByPlaceholderText(/what should ctxpipe do in this workspace/i)
    await waitFor(() =>
      expect(composer()).toHaveValue(
        "Hydrate skipped knowledge/billing/tax.md: Front matter is not valid. Fix the front matter of this file so that it is valid, then open the change.",
      ),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Select workspace" }),
      ).toHaveTextContent("Handbook"),
    )
    // The problem stays until hydrate reads the file.
    expect(canvas.getByText("Handbook: hydrate skipped 1 file")).toBeVisible()
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: the front problem
 * toast names a file of Git and also a skipped legacy overlay file. No edit of
 * the repository fixes the overlay file, so Fix using agent gives the agent
 * only the file of Git.
 */
export const ProblemLegacyOverlayAndFile = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers(
        "owner",
        {},
        { skippedFiles: { handbook: [taxFile, legacyOverlaySkippedFile] } },
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await findNotices(canvasElement, 1)
    await waitFor(() =>
      expect(
        within(region).getByText("Handbook: hydrate skipped 2 files"),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        within(region).getByText(/Front matter is not valid, and 1 more file/),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        within(region).getByText(
          /Knowledge from before Workspaces\. ctxpipe shows it from its database/,
        ),
      ).toBeVisible(),
    )
    await userEvent.click(
      within(region).getByRole("button", {
        name: "Fix using agent: Handbook, skipped files",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        ),
      ).toHaveValue(
        "Hydrate skipped knowledge/billing/tax.md: Front matter is not valid. Fix the front matter of this file so that it is valid, then open the change.",
      ),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: only a legacy
 * overlay file has a problem, so no fix exists and the toast offers Open
 * settings in place of Fix using agent.
 */
export const ProblemLegacyOverlayOnly = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers(
        "owner",
        {},
        { skippedFiles: { handbook: [legacyOverlaySkippedFile] } },
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const region = await findNotices(canvasElement, 1)
    await within(region).findByText("Handbook: hydrate skipped 1 file")
    expect(
      within(region).queryByRole("button", { name: /Fix using agent/ }),
    ).toBeNull()
    expect(
      within(region).getByRole("button", { name: "Open settings: Handbook" }),
    ).toBeVisible()
  },
})

/**
 * Home with two notices in one toast stack, a skipped-files problem in front of
 * an upgrade: the user moved the pointer onto the stack, so it opened and shows
 * both.
 */
export const MixedStack = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers(
        "owner",
        { docs: [upgradeItemFixture()] },
        {
          skippedFiles: {
            handbook: [
              taxFile,
              { path: "knowledge/legal.md", reason: "malformed" },
            ],
          },
        },
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 2)
    const [front] = toastItems(canvasElement)
    if (!front) throw new Error("No toast")
    await waitFor(() =>
      expect(
        within(front).getByText("Handbook: hydrate skipped 2 files"),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText(/and 1 more file/)).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Docs upgrade available")).not.toBeVisible(),
    )
    await userEvent.hover(canvas.getByText("Handbook: hydrate skipped 2 files"))
    await waitFor(() =>
      expect(canvas.getByText("Docs upgrade available")).toBeVisible(),
    )
  },
})

/**
 * Org home page with upgrade and problem notices as toasts: dismissed notices
 * of both types collapse to one button with an icon and a count for each type.
 * The user then pressed it, so the stack shows all three toasts again.
 */
export const CollapsedBothTypes = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...homeHandlers(
        "owner",
        { docs: [upgradeItemFixture(), reingest] },
        { skippedFiles: { handbook: [taxFile] } },
      ),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await findNotices(canvasElement, 3)
    for (const name of [
      "Dismiss: Handbook, skipped files",
      "Dismiss: Docs, Upgrade to format 3",
      "Dismiss: Docs, Fresh re-ingestion of the source repositories",
    ])
      await userEvent.click(await canvas.findByRole("button", { name }))
    const show = () =>
      canvas.getByRole("button", {
        name: "Show notices: 2 upgrades, 1 problem",
      })
    await waitFor(() => expect(show()).toBeVisible())
    expect(show().textContent).toBe("21")
    expect(show().querySelectorAll("svg")).toHaveLength(2)
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Workspace notices" }),
      ).toBeNull(),
    )
    await userEvent.click(show())
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(3))
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: /Show notices/ })).toBeNull(),
    )
  },
})
