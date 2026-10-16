import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor, within } from "storybook/test"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradesHandler,
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

const meta = {
  title: "Pages/Home/Upgrades",
  decorators: orgPageDecorators,
  render: () => <OrgHomePageContent orgSlug="acme" />,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

const answered: string[] = []

type Story = StoryObj<typeof meta>

function homeHandlers(
  role: string,
  upgrades: ReturnType<typeof workspaceUpgradesHandler>[],
) {
  return {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler(role),
          ...workspaceShellHandlers({ workspaces: [docsWorkspace, handbook] }),
          ...upgrades,
        ],
      },
    },
  }
}

/** Only the Workspace with a pending item gets an alert. */
export const AlertForPendingWorkspace: Story = {
  parameters: homeHandlers("owner", [
    workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()]), "docs"),
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "completed" })]),
      "handbook",
    ),
  ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await canvas.findByRole("alert")
    await waitFor(() => expect(alert).toBeVisible())
    await waitFor(async () =>
      expect(
        within(alert).getByText("Docs has 1 upgrade to finish"),
      ).toBeVisible(),
    )
    expect(canvas.queryByText(/Handbook has/)).toBeNull()
    await waitFor(async () =>
      expect(
        within(alert).getByText("An owner or admin must start it."),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        within(alert).getByRole("button", { name: "Review upgrades" }),
      ).toBeVisible(),
    )
  },
}

export const AlertForMember: Story = {
  parameters: homeHandlers("member", [
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture(),
        upgradeItemFixture({ key: "reingest", title: "Ingest again" }),
      ]),
      "docs",
    ),
    workspaceUpgradesHandler(upgradesFixture([]), "handbook"),
  ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await canvas.findByRole("alert")
    await waitFor(async () =>
      expect(
        within(alert).getByText("Docs has 2 upgrades to finish"),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        await within(alert).findByText("Ask an admin to start it."),
      ).toBeVisible(),
    )
  },
}

/** One story for each kind of alert text. */
function singleItemStory(
  item: Parameters<typeof upgradeItemFixture>[0],
  text: string,
): Story {
  return {
    parameters: homeHandlers("owner", [
      workspaceUpgradesHandler(
        upgradesFixture([upgradeItemFixture(item)]),
        "docs",
      ),
      workspaceUpgradesHandler(upgradesFixture([]), "handbook"),
    ]),
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement)
      const alert = await canvas.findByRole("alert")
      await waitFor(async () =>
        expect(await within(alert).findByText(text)).toBeVisible(),
      )
    },
  }
}

export const AlertForRunningUpgrade = singleItemStory(
  { status: "running" },
  "An upgrade is running.",
)

export const AlertForQueuedUpgrade = singleItemStory(
  { status: "queued" },
  "An upgrade is running.",
)

export const AlertForOpenPullRequest = singleItemStory(
  { status: "pr_open" },
  "Review and merge the upgrade pull request.",
)

export const AlertForFailedUpgrade = singleItemStory(
  { status: "failed", failureReason: "GitHub refused the push." },
  "An owner or admin must start it.",
)

export const AlertForBlockedUpgrade = singleItemStory(
  { status: "blocked", blockedReason: "write_access" },
  "ctx| cannot write to the repository. Give the GitHub App write access, then check the Workspace again.",
)

/** No pending item in any Workspace: no alert. */
export const NoAlertWhenNothingPending: Story = {
  parameters: homeHandlers("owner", [
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "completed" })]),
      "docs",
      answered,
    ),
    workspaceUpgradesHandler(upgradesFixture([]), "handbook", answered),
  ]),
  beforeEach: () => {
    answered.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Activity")).toBeVisible(),
    )
    // Both lists must be answered before the check, or it passes too early.
    await waitFor(() => expect(answered).toHaveLength(2))
    await waitFor(() => expect(canvas.queryByText(/to finish/)).toBeNull())
  },
}
