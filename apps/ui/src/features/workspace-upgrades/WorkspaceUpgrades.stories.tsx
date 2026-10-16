import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradeStartHandler,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { UpgradeItemCard, WorkspaceUpgrades } from "./WorkspaceUpgrades"

const startRequests: string[] = []
const state = { started: false }

const meta = {
  title: "Components/Workspaces/Upgrades",
  component: WorkspaceUpgrades,
  decorators: [
    (Story) => (
      <div className="max-w-2xl bg-zinc-950 p-6">
        <Story />
        <Toaster />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  beforeEach: () => {
    startRequests.length = 0
    state.started = false
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("owner"),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({ requests: startRequests }),
        ],
      },
    },
  },
  args: { orgSlug: "acme", workspaceSlug: "docs" },
} satisfies Meta<typeof WorkspaceUpgrades>

export default meta

type Story = StoryObj<typeof meta>

function withUpgrades(
  ...handlers: ReturnType<typeof workspaceUpgradesHandler>[]
) {
  return {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("owner"),
          ...handlers,
          workspaceUpgradeStartHandler({ requests: startRequests }),
        ],
      },
    },
  }
}

export const Loading: Story = {
  parameters: withUpgrades(workspaceUpgradesHandler("loading")),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Loading upgrades")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(canvas.queryByText("No upgrades are pending.")).toBeNull()
  },
}

export const UpToDate: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("No upgrades are pending.")).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        canvas.getByText("The repository uses format 3. It is up to date."),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

/** An admin sees Start. The click queues the item and shows the new status. */
export const AdminStartsUpgrade: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("admin"),
          workspaceUpgradesHandler(() =>
            upgradesFixture([
              upgradeItemFixture({
                status: state.started ? "queued" : "awaiting_operator",
              }),
            ]),
          ),
          workspaceUpgradeStartHandler({
            requests: startRequests,
            onStarted: () => {
              state.started = true
            },
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ready to start")).toBeVisible(),
    )
    await waitFor(async () =>
      expect(canvas.getByText("Export and sources")).toBeVisible(),
    )
    expect(canvas.queryByText("Ask an admin")).toBeNull()
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Start: Upgrade to format 3",
      }),
    )
    await waitFor(() => expect(startRequests).toHaveLength(1))
    expect(startRequests[0]).toMatch(/\/upgrades\/format-3\/start$/)
    await waitFor(async () =>
      expect(await canvas.findByText("Queued")).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull(),
    )
  },
}

/** A member sees "Ask an admin" and no Start button. */
export const MemberAsksAdmin: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("member"),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({ requests: startRequests }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ask an admin")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(startRequests).toHaveLength(0)
  },
}

export const Running: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "running" })]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("Preparing the pull request"),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

/** The pull request is open. The step commits and the notes show. */
export const PullRequestOpen: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          status: "pr_open",
          pullRequest: {
            number: 42,
            url: "https://github.com/acme/docs/pull/42",
          },
          steps: [
            {
              format: 1,
              title: "Export and sources",
              commitSha: "a1b2c3d4e5f6",
              report: ["2 sources could not move. They stay in place."],
            },
            {
              format: 2,
              title: "Move the context files",
              commitSha: null,
              report: [],
            },
          ],
          note: "Merge the pull request to apply the upgrade.",
        }),
      ]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Waiting for merge")).toBeVisible(),
    )
    const link = canvas.getByRole("link", { name: "Pull request #42" })
    await waitFor(() => expect(link).toBeVisible())
    expect(link).toHaveAttribute("href", "https://github.com/acme/docs/pull/42")
    await waitFor(async () => expect(canvas.getByText("a1b2c3d")).toBeVisible())
    await waitFor(async () =>
      expect(
        canvas.getByText("2 sources could not move. They stay in place."),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        canvas.getByText("Merge the pull request to apply the upgrade."),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

export const Failed: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          status: "failed",
          failureReason: "GitHub refused the push to the upgrade branch.",
        }),
      ]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("The upgrade failed")).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        canvas.getByText("GitHub refused the push to the upgrade branch."),
      ).toBeVisible(),
    )
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Start again: Upgrade to format 3",
      }),
    )
    await waitFor(() => expect(startRequests).toHaveLength(1))
  },
}

export const Blocked: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          status: "blocked",
          blockedReason: "write_access",
          note: "The GitHub App has read access only.",
        }),
      ]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("This upgrade cannot start"),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        canvas.getByText(/ctx\| cannot write to the repository/),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        canvas.getByText("The GitHub App has read access only."),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

export const Completed: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "completed" })], {
        formatVersion: 3,
      }),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Applied")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

export const LoadError: Story = {
  parameters: withUpgrades(workspaceUpgradesHandler("error")),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("Could not load the upgrades."),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible(),
    )
  },
}

/**
 * The slot for the cost estimate of a re-ingestion item (CTX-746). The item
 * list fills it when the API gives an estimate.
 */
export const EstimateSlot: Story = {
  render: () => (
    <ul>
      <UpgradeItemCard
        item={upgradeItemFixture({
          key: "reingest",
          title: "Ingest the Workspace sources again",
          steps: [],
        })}
        isAdmin
        onStart={() => {}}
        estimate={<span>Estimated cost: about 4 USD for 120 files.</span>}
      />
    </ul>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("Estimated cost: about 4 USD for 120 files."),
      ).toBeVisible(),
    )
  },
}

/** The estimate of the item shows in its card when the API gives one. */
export const EstimateFromItem: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          key: "reingest",
          title: "Ingest the Workspace sources again",
          steps: [],
          estimate: "Estimated cost: about 4 USD for 120 files.",
        }),
      ]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("Estimated cost: about 4 USD for 120 files."),
      ).toBeVisible(),
    )
  },
}

/** The server refuses the start (409). The card shows the reason in a toast. */
export const StartRefused: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("owner"),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({
            requests: startRequests,
            answer: 409,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Start: Upgrade to format 3",
      }),
    )
    await waitFor(() => expect(startRequests).toHaveLength(1))
    await waitFor(async () =>
      expect(await canvas.findByText("The upgrade is blocked")).toBeVisible(),
    )
    // The card keeps its Start button: nothing was queued.
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Start: Upgrade to format 3" }),
      ).toBeEnabled(),
    )
  },
}

/** The role never answers. Neither Start nor "Ask an admin" shows. */
export const RoleNeverAnswers: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            "*/.auth/api/v1/auth/organization/get-active-member-role",
            async () => {
              await delay("infinite")
            },
          ),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({ requests: startRequests }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ready to start")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(canvas.queryByText("Ask an admin")).toBeNull()
  },
}
