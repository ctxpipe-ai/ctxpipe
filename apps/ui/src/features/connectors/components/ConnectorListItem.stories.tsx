import type { Meta, StoryObj } from "@storybook/react-vite"
import { IconBrandGithub } from "@tabler/icons-react"
import { expect, userEvent, within } from "storybook/test"
import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
import {
  ConnectorListItem,
  ConnectorListItemSkeleton,
} from "./ConnectorListItem"

const meta = {
  title: "Components/Connections/ListItem",
  component: ConnectorListItem,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl border-t border-white/[0.06]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConnectorListItem>

export default meta

type Story = StoryObj<typeof meta>

const shared = {
  name: "GitHub",
  icon: <IconBrandGithub className="size-5 text-foreground" aria-hidden />,
  remove: {
    description: "This unlinks the GitHub App installation from ctxpipe.",
    onConfirm: () => {},
  },
  workspace: "acme",
  actionLabel: "Link to a workspace",
  onAction: () => {},
}

export const Connected: Story = {
  args: {
    ...shared,
    health: "connected",
  },
}

export const Expanded: Story = {
  args: {
    ...shared,
    health: "connected",
    defaultExpanded: true,
  },
}

export const PendingSetup: Story = {
  args: {
    ...shared,
    health: "setup_pending",
    workspace: "—",
    actionLabel: "Complete GitHub install",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Setup not finished")
    expect(
      canvas.getByRole("button", { name: "Remove GitHub setup" }),
    ).toBeVisible()
    expect(
      canvas.getByRole("button", {
        name: "Complete GitHub install for GitHub",
      }),
    ).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: /connector actions/ }),
    ).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Expand GitHub" }))
    await canvas.findByText("Account")
    expect(
      canvas.getAllByRole("button", { name: /Complete GitHub install/ }),
    ).toHaveLength(1)
  },
}

/** At phone width the name keeps its room; the status and actions wrap. */
export const PendingSetupNarrow: Story = {
  args: {
    ...shared,
    name: "Atlassian Confluence",
    health: "setup_pending",
    actionLabel: "Link Atlassian account",
  },
  decorators: [
    (Story) => (
      <div className="w-[375px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = await canvas.findByText("Atlassian Confluence")
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth)
    const remove = canvas.getByRole("button", {
      name: "Remove Atlassian Confluence setup",
    })
    const nameBox = name.getBoundingClientRect()
    expect(remove.getBoundingClientRect().top).toBeGreaterThan(nameBox.bottom)
    const expand = canvas.getByRole("button", {
      name: "Expand Atlassian Confluence",
    })
    expect(expand.getBoundingClientRect().top).toBeLessThan(nameBox.bottom)
    const action = canvas.getByRole("button", {
      name: "Link Atlassian account for Atlassian Confluence",
    })
    expect(action.scrollHeight).toBeLessThanOrEqual(action.clientHeight)
  },
}

export const CouldntLoad: Story = {
  args: {
    ...shared,
    health: "couldnt_load",
    defaultExpanded: true,
    actionLabel: "Retry",
    children: (
      <p className="text-sm text-muted-foreground">
        Status request failed. Retry, or open setup if this persists.
      </p>
    ),
  },
}

export const SyncFailed: Story = {
  args: {
    ...shared,
    health: "sync_failed",
    defaultExpanded: true,
    actionLabel: "Review failure",
    children: (
      <p className="text-sm text-muted-foreground">
        Content mirror failed. Open setup to retry.
      </p>
    ),
  },
}

export const ConfigPrFailed: Story = {
  args: {
    ...shared,
    health: "config_failed",
    defaultExpanded: true,
    actionLabel: "Review failure",
    children: (
      <p className="text-sm text-muted-foreground">
        Configuration pull request failed. Open setup to retry.
      </p>
    ),
  },
}

export const Checking: Story = {
  args: {
    ...shared,
    health: "checking",
    workspace: "—",
    actionLabel: undefined,
    onAction: undefined,
  },
}

/** The loading row has the same box as a collapsed connector row. */
export const ConnectorRowSkeletonMatches: Story = {
  tags: ["workspace-golden"],
  args: {
    ...shared,
    health: "connected",
  },
  render: (args) => (
    <SkeletonMatchFrame
      className="w-xl"
      skeleton={<ConnectorListItemSkeleton />}
      loaded={<ConnectorListItem {...args} />}
    />
  ),
  play: async ({ canvasElement }) => {
    await expectSkeletonMatchesLoaded(canvasElement)
  },
}
