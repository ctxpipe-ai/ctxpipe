import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
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
  title: "Pages/Home/Upgrades",
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
) {
  return {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler(role),
          ...workspaceShellHandlers({ workspaces: [docsWorkspace, handbook] }),
          pendingWorkspaceUpgradesHandler(items, answered),
          workspaceUpgradeStartHandler({ requests }),
          ...workspaceUpgradeAutomaticHandlers({ requests }),
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
    name: "Workspace upgrades",
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
      name: "Workspace upgrades",
    })
    await waitFor(() =>
      expect(within(region).getByText("Docs upgrade available")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        within(region).getByText(/into \.ctxpipe\/sources\.yaml/),
      ).toBeVisible(),
    )
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
 * Always update saves the setting, waits for its commit, then starts this
 * item, so the pull request contains the setting.
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
      expect(requests).toEqual([
        "/acme/api/v1/workspaces/docs/upgrades/automatic",
        "/acme/api/v1/workspaces/docs/files/jobs/wjob_automatic",
        "/acme/api/v1/workspaces/docs/upgrades/format-3/start",
      ]),
    )
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
        canvas.queryByRole("region", { name: "Workspace upgrades" }),
      ).toBeNull(),
    )
    expect(requests).toEqual([])
    expect(window.localStorage.getItem("ctxpipe:userPreferences")).toContain(
      "acme/docs/format-3/awaiting_operator",
    )
    // The dismissed toast collapses to one icon button, with no count badge.
    const show = await canvas.findByRole("button", {
      name: "Show upgrades (1)",
    })
    expect(show.textContent).toBe("")
    await userEvent.click(show)
    await waitFor(() =>
      expect(canvas.getByText("Docs upgrade available")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("button", { name: /Show upgrades/ }),
      ).toBeNull(),
    )
  },
}

/** Two dismissed toasts collapse to one icon with a count; a press restores both. */
export const DismissedCollapseToIcon: Story = {
  parameters: homeHandlers("owner", threeItems),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("region", { name: "Workspace upgrades" })
    // No toast is dismissed yet, so there is no icon.
    expect(canvas.queryByRole("button", { name: /Show upgrades/ })).toBeNull()
    for (const name of [
      "Dismiss: Docs, Upgrade to format 3",
      "Dismiss: Docs, Fresh re-ingestion of the source repositories",
    ])
      await userEvent.click(await canvas.findByRole("button", { name }))
    const show = await canvas.findByRole("button", {
      name: "Show upgrades (2)",
    })
    await waitFor(() => expect(show).toBeVisible())
    expect(show.textContent).toBe("2")
    // The Handbook toast stays in the stack.
    expect(canvas.getByText("Handbook upgrade available")).toBeVisible()
    await userEvent.click(show)
    await waitFor(() => expect(toastItems(canvasElement)).toHaveLength(3))
    await waitFor(() =>
      expect(
        canvas.queryByRole("button", { name: /Show upgrades/ }),
      ).toBeNull(),
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
    await canvas.findByRole("region", { name: "Workspace upgrades" })
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
        canvas.getByText(/publishes the new knowledge files/),
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
      name: "Workspace upgrades",
    })
    await waitFor(() =>
      expect(
        within(region).getAllByText("An owner or admin can start it.")[0],
      ).toBeVisible(),
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
    await canvas.findByRole("region", { name: "Workspace upgrades" })
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
        canvas.queryByRole("region", { name: "Workspace upgrades" }),
      ).toBeNull(),
    )
  },
}
