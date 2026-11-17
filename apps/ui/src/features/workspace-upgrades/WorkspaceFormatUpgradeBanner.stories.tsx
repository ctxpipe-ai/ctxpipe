import type { Meta, StoryObj } from "@storybook/react-vite"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradeStartHandler,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceFormatUpgradeBanner } from "./WorkspaceFormatUpgradeBanner"

const startRequests: string[] = []
const answered: string[] = []

function handlers(
  role: "owner" | "member",
  upgrades: Parameters<typeof workspaceUpgradesHandler>[0],
) {
  return {
    msw: {
      handlers: {
        session: signedInHandlers,
        page: [
          activeMemberRoleHandler(role),
          workspaceUpgradesHandler(upgrades, undefined, answered),
          workspaceUpgradeStartHandler({ requests: startRequests }),
        ],
      },
    },
  }
}

const meta = {
  title: "Components/Workspaces/FormatUpgradeBanner",
  component: WorkspaceFormatUpgradeBanner,
  decorators: [
    (Story) => (
      <div className="max-w-2xl bg-card">
        <Story />
        <Toaster />
      </div>
    ),
  ],
  beforeEach: () => {
    startRequests.length = 0
    answered.length = 0
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    ...handlers("owner", upgradesFixture([upgradeItemFixture()])),
    review: { kind: "component" },
  },
  args: { orgSlug: "acme", workspaceSlug: "docs" },
} satisfies Meta<typeof WorkspaceFormatUpgradeBanner>

export default meta

type Story = StoryObj<typeof meta>

const title = "This Workspace needs the format upgrade"

/**
 * Format upgrade banner of a Workspace, for an owner: the Workspace needs the
 * upgrade, and the owner can start it from the banner or open Upgrades to
 * review it (CTX-932).
 */
export const OwnerCanStart: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(title)
    expect(
      canvas.getByText(/Until you merge the upgrade, the sources/),
    ).toBeVisible()
    expect(
      canvas.getByRole("link", { name: "Review upgrade" }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
    // The role loads after the banner, so the button comes late.
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start the upgrade" }),
    )
    await waitFor(() =>
      expect(startRequests).toEqual([
        "/acme/api/v1/workspaces/docs/upgrades/format-3/start",
      ]),
    )
  },
}

/**
 * Format upgrade banner of a Workspace, for a member: the Workspace needs the
 * upgrade, and the member must ask an admin. The banner has no Start button for
 * a member.
 */
export const MemberAsksAdmin: Story = {
  parameters: {
    ...handlers("member", upgradesFixture([upgradeItemFixture()])),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(title)
    await waitFor(() => expect(canvas.getByText("Ask an admin")).toBeVisible())
    expect(
      canvas.queryByRole("button", { name: "Start the upgrade" }),
    ).toBeNull()
    expect(canvas.getByRole("link", { name: "Review upgrade" })).toBeVisible()
    expect(startRequests).toEqual([])
  },
}

/**
 * Format upgrade banner of a Workspace: ctxpipe never read the format and has
 * no upgrade item yet, so there is no Start button. The Review upgrade link
 * opens Upgrades, where the user can check again.
 */
export const NoItemYet: Story = {
  parameters: {
    ...handlers("owner", upgradesFixture([], { formatVersion: 0 })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(title)
    expect(canvas.getByText(/has not found the upgrade yet/)).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: "Start the upgrade" }),
    ).toBeNull()
    expect(canvas.getByRole("link", { name: "Review upgrade" })).toBeVisible()
  },
}

/**
 * Format upgrade banner of a Workspace: ctxpipe prepares the upgrade pull
 * request now.
 */
export const Running: Story = {
  parameters: {
    ...handlers(
      "owner",
      upgradesFixture([upgradeItemFixture({ status: "running" })]),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(title)
    expect(
      canvas.getByText("ctxpipe is preparing the upgrade pull request now."),
    ).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: "Start the upgrade" }),
    ).toBeNull()
  },
}

/**
 * Format upgrade banner at the top of the Workspace page, seen by an owner:
 * ctxpipe opened the upgrade pull request, so the banner says to merge it on
 * GitHub and links to it.
 */
export const PullRequestOpen: Story = {
  parameters: {
    ...handlers(
      "owner",
      upgradesFixture([
        upgradeItemFixture({
          status: "pr_open",
          pullRequest: {
            number: 52,
            url: "https://github.com/acme/docs/pull/52",
          },
        }),
      ]),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(title)
    expect(canvas.getByText(/Merge it on GitHub/)).toBeVisible()
    expect(
      canvas.getByRole("link", { name: "Open pull request" }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/52")
  },
}

/**
 * Format upgrade banner of a Workspace: the upgrade failed, and the banner
 * gives the cause and the next step instead of a Start button.
 */
export const Failed: Story = {
  parameters: {
    ...handlers(
      "owner",
      upgradesFixture([
        upgradeItemFixture({
          status: "failed",
          failureReason: "stdout maxBuffer length exceeded",
          failure: {
            code: "unknown",
            step: null,
            repository: null,
            summary: "stdout maxBuffer length exceeded",
          },
        }),
      ]),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("The format upgrade failed")
    expect(canvas.getByText(/does not know the cause/)).toBeVisible()
    expect(canvas.getByRole("link", { name: "Review upgrade" })).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: "Start the upgrade" }),
    ).toBeNull()
  },
}

/**
 * Format upgrade banner of a Workspace: the upgrade is blocked because the
 * GitHub App cannot write to the repository.
 */
export const Blocked: Story = {
  parameters: {
    ...handlers(
      "owner",
      upgradesFixture([
        upgradeItemFixture({
          status: "blocked",
          blockedReason: "write_access",
          note: "The GitHub App cannot write to this repository.",
        }),
      ]),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(title)
    expect(
      canvas.getByText(/The GitHub App cannot write to this repository\./),
    ).toBeVisible()
    expect(canvas.getByRole("link", { name: "Review upgrade" })).toBeVisible()
  },
}

/**
 * Format upgrade banner of a Workspace at the newest format: the banner stays
 * hidden. The play waits for the answer of the read, so that the check does not
 * pass too early.
 */
export const UpToDate: Story = {
  parameters: {
    visual: {
      skip: "Behavior test: at the newest format the banner renders nothing, so the screenshot is empty.",
    },
    ...handlers(
      "owner",
      upgradesFixture([upgradeItemFixture({ status: "completed" })], {
        formatVersion: 3,
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The read must be answered before the check, or it passes too early.
    await waitFor(() => expect(answered).not.toHaveLength(0))
    expect(canvas.queryByText(title)).toBeNull()
    expect(canvas.queryByRole("link", { name: "Review upgrade" })).toBeNull()
  },
}
