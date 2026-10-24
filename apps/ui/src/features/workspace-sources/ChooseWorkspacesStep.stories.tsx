import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  pendingWorkspaceUpgradesHandler,
  upgradeItemFixture,
} from "@/mocks/workspace-upgrades-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "../workspaces/workspace-fixtures"
import {
  CHOOSE_WORKSPACES_HINT,
  ChooseWorkspacesStep,
} from "./ChooseWorkspacesStep"
import {
  type ChooseWorkspacesValue,
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
} from "./choose-workspaces"

/** The step with its state, as a wizard holds it. */
function StepWithState(
  props: Omit<
    ComponentProps<typeof ChooseWorkspacesStep>,
    "value" | "onChange"
  >,
) {
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  const requests = chooseWorkspacesRequests(value, props)
  return (
    <>
      <ChooseWorkspacesStep {...props} value={value} onChange={setValue} />
      <output className="mt-4 block text-xs text-muted-foreground">
        {requests ? `${requests.length} ready` : "Not ready"}
      </output>
    </>
  )
}

const meta = {
  title: "Components/WorkspaceSources/ChooseWorkspacesStep",
  component: StepWithState,
  decorators: [
    (Story) => (
      <div className="max-w-lg bg-zinc-950 p-4">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
          linearAvailableScopesHandler(),
        ],
      },
    },
  },
  args: { orgSlug: "acme", provider: "linear", connectionId: "con_li1" },
} satisfies Meta<typeof StepWithState>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(/\/api\/v1\/workspaces$/, async () => {
            await delay("infinite")
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Loading Workspaces")
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
  },
}

export const ShowsHint: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: docsWorkspace.displayName })
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
    await expect(canvas.getByText("Not ready")).toBeVisible()
  },
}

export const SingleWorkspace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await expect(canvas.queryByRole("radiogroup")).toBeNull()
    await expect(canvas.getByText("Not ready")).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering/ }),
    )
    await expect(canvas.getByText("1 ready")).toBeVisible()
  },
}

export const ChooseWorkspacesMulti: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      canvas.getByRole("checkbox", { name: readOnlyWorkspace.displayName }),
    )
    await expect(
      canvas.getByRole("radio", { name: /Same scope/ }),
    ).toBeChecked()
    await expect(
      await canvas.findAllByRole("group", {
        name: "Linear teams and projects",
      }),
    ).toHaveLength(1)
    await userEvent.click(canvas.getByRole("checkbox", { name: /Engineering/ }))
    await expect(canvas.getByText("2 ready")).toBeVisible()

    await userEvent.click(
      canvas.getByRole("radio", { name: /different scope/ }),
    )
    const own = (name: string) =>
      canvas.findByRole("group", {
        name: `Linear teams and projects for ${name}`,
      })
    await userEvent.click(
      within(await own(docsWorkspace.displayName)).getByRole("checkbox", {
        name: /Operations/,
      }),
    )
    await expect(await own(readOnlyWorkspace.displayName)).toBeVisible()
    await expect(canvas.getByText("Not ready")).toBeVisible()
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
  },
}

const docsAndHandbook = workspaceListHandler([docsWorkspace, readOnlyWorkspace])

/**
 * A Workspace below the newest format refuses a source (CTX-935): its row is
 * off, says so, and links to its upgrade. The other Workspace stays usable.
 */
export const OneWorkspaceNeedsUpgrade: Story = {
  parameters: {
    msw: {
      handlers: {
        pendingUpgrades: [
          pendingWorkspaceUpgradesHandler({
            [docsWorkspace.slug]: [upgradeItemFixture()],
          }),
        ],
        page: [
          docsAndHandbook,
          linearAvailableScopesHandler(),
          activeMemberRoleHandler("owner"),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: docsWorkspace.displayName })
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeDisabled(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: readOnlyWorkspace.displayName }),
      ).toBeEnabled(),
    )
    await expect(
      canvas.getByText(/Needs the format upgrade first/),
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Review upgrade" }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
    // Some Workspace can still take the source: no page-level notice.
    await expect(
      canvas.queryByText("Upgrade a Workspace before you add a source"),
    ).toBeNull()
  },
}

/** Each Workspace needs the upgrade: the step says so, and no row can be chosen. */
export const AllWorkspacesNeedUpgrade: Story = {
  parameters: {
    msw: {
      handlers: {
        pendingUpgrades: [
          pendingWorkspaceUpgradesHandler({
            [docsWorkspace.slug]: [upgradeItemFixture()],
            [readOnlyWorkspace.slug]: [
              upgradeItemFixture({ status: "failed" }),
            ],
          }),
        ],
        page: [
          docsAndHandbook,
          linearAvailableScopesHandler(),
          activeMemberRoleHandler("member"),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Upgrade a Workspace before you add a source")
    for (const workspace of [docsWorkspace, readOnlyWorkspace])
      await expect(
        canvas.getByRole("checkbox", { name: workspace.displayName }),
      ).toBeDisabled()
    await waitFor(() => expect(canvas.getByText("Ask an admin")).toBeVisible())
    await expect(canvas.getByText("Not ready")).toBeVisible()
  },
}

/**
 * A Workspace below the newest format that has no upgrade item yet (the scan
 * did not record one): the read still lists it with its format, so its row is
 * off and links to its upgrade, and the other Workspace stays usable.
 */
export const BelowFormatWithNoUpgradeRowYet: Story = {
  parameters: {
    msw: {
      handlers: {
        pendingUpgrades: [
          pendingWorkspaceUpgradesHandler({}, undefined, {
            formats: { [docsWorkspace.slug]: 1 },
          }),
        ],
        page: [
          docsAndHandbook,
          linearAvailableScopesHandler(),
          activeMemberRoleHandler("owner"),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: docsWorkspace.displayName })
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeDisabled(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: readOnlyWorkspace.displayName }),
      ).toBeEnabled(),
    )
    await expect(
      canvas.getByRole("link", { name: "Review upgrade" }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
  },
}

/**
 * The read of the pending upgrades loads for a long time: the step shows its
 * skeleton and no row, because it cannot tell which Workspace the server
 * refuses.
 */
export const NoRowsWhileFormatCheckLoads: Story = {
  parameters: {
    msw: {
      handlers: {
        pendingUpgrades: [
          http.get(/\/workspace-upgrades\/pending$/, () => delay("infinite")),
        ],
        page: [
          docsAndHandbook,
          linearAvailableScopesHandler(),
          activeMemberRoleHandler("owner"),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Loading Workspaces")
    await expect(canvas.queryAllByRole("checkbox")).toHaveLength(0)
  },
}

/** The read fails: the rows stay off, and the step says why, with Retry. */
export const FormatCheckFailed: Story = {
  parameters: {
    msw: {
      handlers: {
        pendingUpgrades: [
          pendingWorkspaceUpgradesHandler({}, undefined, { answer: "error" }),
        ],
        page: [
          docsAndHandbook,
          linearAvailableScopesHandler(),
          activeMemberRoleHandler("owner"),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(
      /Could not check which Workspaces need the format upgrade/,
    )
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
    for (const workspace of [docsWorkspace, readOnlyWorkspace])
      await expect(
        canvas.getByRole("checkbox", { name: workspace.displayName }),
      ).toBeDisabled()
  },
}
