import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import type { WorkspaceSkippedFile } from "@/features/workspaces/types"
import {
  docsWorkspace,
  docsWorkspaceDetail,
  legacyOverlaySkippedFile,
} from "@/features/workspaces/workspace-fixtures"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  pendingWorkspaceUpgradesHandler,
  upgradeItemFixture,
  workspaceUpgradeAutomaticHandlers,
  workspaceUpgradeStartHandler,
} from "@/mocks/workspace-upgrades-handlers"
import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
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

const meta = {
  title: "Pages/Home/Notices",
  decorators: orgPageDecorators,
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: () => {
    answered.length = 0
    perWorkspaceReads.length = 0
    requests.length = 0
    // A dismissed toast of an earlier story must not hide a toast here.
    window.localStorage.removeItem("ctxpipe:userPreferences")
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

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
  skippedFiles: Record<string, WorkspaceSkippedFile[]> = {},
  automaticJob?: { status: string; failureReason: string | null },
) {
  return {
    msw: {
      handlers: {
        // The global default answers "no pending upgrade"; this key replaces it.
        pendingUpgrades: [pendingWorkspaceUpgradesHandler(items, answered)],
        page: [
          activeMemberRoleHandler(role),
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
          ...workspaceShellHandlers({ workspaces: [docsWorkspace, handbook] }),
          workspaceUpgradeStartHandler({ requests }),
          ...workspaceUpgradeAutomaticHandlers({
            requests,
            ...(automaticJob ? { job: automaticJob } : {}),
          }),
          // The home reads the org once. A read of one Workspace fails the story.
          http.get(/\/workspaces\/[^/]+\/upgrades$/, () => {
            perWorkspaceReads.push("upgrades")
            return HttpResponse.json({ error: "Not expected" }, { status: 500 })
          }),
        ],
      },
    },
  }
}

const threeItems = {
  docs: [upgradeItemFixture(), reingest],
  handbook: [upgradeItemFixture()],
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

/** One toast for the one Workspace item that waits for a start. */
export const SingleToast: Story = {
  parameters: homeHandlers("owner", {
    docs: [upgradeItemFixture()],
    handbook: [upgradeItemFixture({ status: "completed" })],
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
    await waitFor(() =>
      expect(within(region).getByText("Docs upgrade available")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        within(region).getByText(
          "ctx| opens a pull request for format 3. Nothing changes until you merge it.",
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
}

/**
 * CTX-939. The toast is a title and one short line, so it does not cover the
 * composer. When the toast goes, it leaves no gap: the composer moves back up
 * by the height of the toast.
 */
export const ToastTakesNoSpaceAfterItGoes: Story = {
  parameters: homeHandlers("owner", { docs: [upgradeItemFixture()] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
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
}

/** Update once starts this item with the existing start API. */
export const UpdateOnce: Story = {
  parameters: homeHandlers("owner", { docs: [upgradeItemFixture()] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
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
  },
}

/**
 * Always update answers at once. The server saves the setting and starts the
 * upgrade, so the browser sends no start request and does not wait for the
 * commit. The toast follows the save as progress.
 */
export const AlwaysUpdate: Story = {
  parameters: homeHandlers("owner", { docs: [upgradeItemFixture()] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Always update: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(
          "ctx| saved the setting. The upgrade starts in a moment.",
        ),
      ).toBeVisible(),
    )
    expect(requests).toEqual([
      "/acme/api/v1/workspaces/docs/upgrades/automatic",
      "/acme/api/v1/workspaces/docs/files/jobs/wjob_automatic",
    ])
    expect(requests.some((path) => path.endsWith("/start"))).toBe(false)
  },
}

/**
 * A slow save does not block the toast: it says that the server saves and
 * starts the upgrade, and the other buttons stay usable. Dismiss still works.
 */
export const AlwaysUpdateSlowSave: Story = {
  parameters: homeHandlers(
    "owner",
    { docs: [upgradeItemFixture()] },
    {},
    { status: "running", failureReason: null },
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Always update: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/ctx\| saves the setting\. It starts the upgrade/),
      ).toBeVisible(),
    )
    expect(canvas.getByText(/You can leave this page/)).toBeVisible()
    // The save runs on the server: nothing starts in the browser.
    expect(requests.some((path) => path.endsWith("/start"))).toBe(false)
  },
}

/** A failed save shows its cause and the next steps. */
export const AlwaysUpdateSaveFails: Story = {
  parameters: homeHandlers(
    "owner",
    { docs: [upgradeItemFixture()] },
    {},
    {
      status: "failed",
      failureReason:
        "The write stopped before it finished. stdout maxBuffer length exceeded",
    },
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Always update: Docs, Upgrade to format 3",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/ctx\| could not save the setting\./),
      ).toBeVisible(),
    )
    expect(canvas.getByText(/stdout maxBuffer length exceeded/)).toBeVisible()
    expect(
      canvas.getByRole("link", {
        name: "Open Upgrades: Docs, Upgrade to format 3",
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
}

const failedUpgrade = upgradeItemFixture({
  status: "failed",
  failureReason: "stdout maxBuffer length exceeded",
  failure: {
    code: "unknown",
    step: null,
    repository: null,
    summary: "stdout maxBuffer length exceeded",
  },
})

/**
 * A failed item has a cause that can repeat, so the toast offers no Update
 * once and no Always update. It shows the cause and two next steps. Ask the
 * agent puts the prompt into the composer of that Workspace.
 */
export const FailedUpgrade: Story = {
  parameters: homeHandlers("owner", { docs: [failedUpgrade] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
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
        name: "Open Upgrades: Docs, Upgrade to format 3",
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
}

/** A member sees the cause and the next steps of a failed upgrade too. */
export const FailedUpgradeMember: Story = {
  parameters: homeHandlers("member", { docs: [failedUpgrade] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
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
}

/** Dismiss hides the toast in this browser and starts nothing. */
export const Dismiss: Story = {
  parameters: homeHandlers("owner", { docs: [upgradeItemFixture()] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
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
}

/** Two dismissed toasts collapse to one icon with a count; a press restores both. */
export const DismissedCollapseToIcon: Story = {
  parameters: homeHandlers("owner", threeItems),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("region", { name: "Workspace notices" })
    // No toast is dismissed yet, so there is no icon.
    expect(canvas.queryByRole("button", { name: /Show notices/ })).toBeNull()
    for (const name of [
      "Dismiss: Docs, Upgrade to format 3",
      "Dismiss: Docs, Fresh re-ingestion of the source repositories",
    ])
      await userEvent.click(await canvas.findByRole("button", { name }))
    const show = await canvas.findByRole("button", {
      name: "Show notices: 2 upgrades",
    })
    await waitFor(() => expect(show).toBeVisible())
    expect(show.textContent).toBe("2")
    // The Handbook toast stays in the stack.
    expect(canvas.getByText("Handbook upgrade available")).toBeVisible()
    await userEvent.click(show)
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(3))
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: /Show notices/ })).toBeNull(),
    )
  },
}

/**
 * Three toasts in one stack. Only the front toast shows; the others are
 * edges behind it. The pointer opens the stack, and Tab reaches each toast.
 */
export const StackOfThree: Story = {
  parameters: homeHandlers("owner", threeItems),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("region", { name: "Workspace notices" })
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(3))
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
          "ctx| reads each source repository again. This uses model calls.",
        ),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).toBeVisible(),
    )
  },
}

/** A member gets the toast with a quiet line and no button. */
export const MemberView: Story = {
  parameters: homeHandlers("member", threeItems),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
    await waitFor(() =>
      expect(within(region).getAllByText("Ask an admin")[0]).toBeVisible(),
    )
    await waitFor(() =>
      expect(within(region).queryAllByRole("button")).toHaveLength(0),
    )
  },
}

/** With reduced motion the stack opens and closes with no transition. */
export const ReducedMotion: Story = {
  tags: ["reduced-motion"],
  parameters: homeHandlers("owner", threeItems),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("region", { name: "Workspace notices" })
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(3))
    for (const item of toastItems(canvasElement))
      expect(
        Number.parseFloat(getComputedStyle(item).transitionDuration),
      ).toBeLessThan(0.001)
    await userEvent.hover(frontTitle(canvasElement))
    await waitFor(() =>
      expect(canvas.getByText("Handbook upgrade available")).toBeVisible(),
    )
  },
}

/** An item that no one can start now (running, open pull request, blocked) gets no toast. */
export const NoToastWhenNothingToStart: Story = {
  parameters: homeHandlers("owner", {
    docs: [
      upgradeItemFixture({ status: "running" }),
      { ...reingest, status: "blocked", blockedReason: "needs_format" },
    ],
    handbook: [upgradeItemFixture({ status: "pr_open" })],
  }),
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
}

const taxFile: WorkspaceSkippedFile = {
  path: "knowledge/billing/tax.md",
  reason: "malformed",
}

/**
 * A hydrate problem shows as a warning toast, with no upgrade. Fix using
 * agent puts the fix prompt into the composer of that Workspace.
 */
export const ProblemOnly: Story = {
  parameters: homeHandlers("owner", {}, { handbook: [taxFile] }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
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
}

/**
 * A skipped legacy overlay file is knowledge from the database, so no edit
 * of the Workspace repository fixes it. Hydrate lists the files of Git first,
 * so the front toast names the file of Git and also the overlay cause. The
 * agent gets only the file of Git.
 */
export const ProblemLegacyOverlayAndFile: Story = {
  parameters: homeHandlers(
    "owner",
    {},
    { handbook: [taxFile, legacyOverlaySkippedFile] },
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
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
          /Knowledge from before Workspaces\. ctx\| shows it from its database/,
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
}

/** Only a legacy overlay file: no fix exists, so the toast opens settings. */
export const ProblemLegacyOverlayOnly: Story = {
  parameters: homeHandlers(
    "owner",
    {},
    { handbook: [legacyOverlaySkippedFile] },
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const region = await canvas.findByRole("region", {
      name: "Workspace notices",
    })
    await within(region).findByText("Handbook: hydrate skipped 1 file")
    expect(
      within(region).queryByRole("button", { name: /Fix using agent/ }),
    ).toBeNull()
    expect(
      within(region).getByRole("button", { name: "Open settings: Handbook" }),
    ).toBeVisible()
  },
}

/** A problem and an upgrade in one stack: the problem is in front. */
export const MixedStack: Story = {
  parameters: homeHandlers(
    "owner",
    { docs: [upgradeItemFixture()] },
    {
      handbook: [taxFile, { path: "knowledge/legal.md", reason: "malformed" }],
    },
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("region", { name: "Workspace notices" })
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(2))
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
}

/**
 * Dismissed notices of both types collapse to one button with an icon and
 * a count for each type. A press shows the stack again.
 */
export const CollapsedBothTypes: Story = {
  parameters: homeHandlers(
    "owner",
    { docs: [upgradeItemFixture(), reingest] },
    { handbook: [taxFile] },
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("region", { name: "Workspace notices" })
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(3))
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
}
