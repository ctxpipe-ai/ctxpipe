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
    expect(
      within(alert).getByText("Docs has 1 upgrade to finish"),
    ).toBeVisible()
    expect(canvas.queryByText(/Handbook has/)).toBeNull()
    expect(
      within(alert).getByText(
        "Nothing runs until an owner or admin starts it.",
      ),
    ).toBeVisible()
    expect(
      within(alert).getByRole("button", { name: "Review upgrades" }),
    ).toBeVisible()
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
    expect(
      within(alert).getByText("Docs has 2 upgrades to finish"),
    ).toBeVisible()
    expect(
      await within(alert).findByText(
        "Only an owner or admin can start an upgrade. Ask an admin.",
      ),
    ).toBeVisible()
  },
}

/** No pending item in any Workspace: no alert. */
export const NoAlertWhenNothingPending: Story = {
  parameters: homeHandlers("owner", [
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "completed" })]),
    ),
  ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(await canvas.findByText("Activity")).toBeVisible()
    // Give the upgrade lists time to settle before the check.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(canvas.queryByText(/to finish/)).toBeNull()
  },
}
