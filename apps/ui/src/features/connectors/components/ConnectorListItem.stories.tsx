import type { Meta, StoryObj } from "@storybook/react-vite"
import { IconBrandGithub } from "@tabler/icons-react"
import { expect, userEvent, within } from "storybook/test"

import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"

import { ConfluenceMark } from "./ConfluenceMark"
import {
  ConnectorListItem,
  ConnectorListItemSkeleton,
} from "./ConnectorListItem"

const meta = {
  title: "Components/Connections/ListItem",
  component: ConnectorListItem,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
  decorators: [
    (Story) => (
      <div className="flex w-xl max-w-full flex-col gap-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConnectorListItem>

export default meta

type Story = StoryObj<typeof meta>

const shared = {
  connectionId: "con_story_github",
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

export const Expanded: Story = {
  parameters: {
    review: {
      purpose:
        "Connector row on the Connectors page, with health and actions for one connection: a connected GitHub row, expanded to show its details.",
    },
  },
  args: {
    ...shared,
    health: "connected",
    defaultExpanded: true,
  },
}

export const PendingSetup: Story = {
  parameters: {
    review: {
      purpose:
        "Connector row on the Connectors page, with health and actions for one connection: GitHub setup is not finished, the row is open.",
    },
  },
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
    await userEvent.click(canvas.getByRole("button", { name: "GitHub" }))
    await canvas.findByText("Account")
    expect(
      canvas.getAllByRole("button", { name: /Complete GitHub install/ }),
    ).toHaveLength(1)
  },
}

/** At phone width the name keeps its room; the status and actions wrap. */
export const PendingSetupNarrow: Story = {
  parameters: {
    review: {
      purpose:
        "Connector row on the Connectors page at phone width: the Confluence setup is not finished, so the status moves under the name and Remove and the next step wrap below.",
    },
  },
  args: {
    ...shared,
    name: "Confluence",
    icon: <ConfluenceMark className="size-5 text-foreground" />,
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
    // The mark has its own <title>; the name is the span of the trigger.
    const name = await canvas.findByText("Confluence", { selector: "span" })
    await document.fonts.ready
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth)
    const remove = canvas.getByRole("button", {
      name: "Remove Confluence setup",
    })
    const nameBox = name.getBoundingClientRect()
    expect(remove.getBoundingClientRect().top).toBeGreaterThan(nameBox.bottom)
    // A narrow tile puts the status under the name, left-aligned with it,
    // so the name keeps its width.
    // The indicator (the dot, then the word) starts at the left edge of the name.
    const status = canvas.getByText("Setup not finished").parentElement
    if (!status) throw new Error("No status indicator")
    const statusBox = status.getBoundingClientRect()
    expect(statusBox.top).toBeGreaterThanOrEqual(nameBox.bottom)
    expect(Math.abs(statusBox.left - nameBox.left)).toBeLessThanOrEqual(2)
    expect(remove.getBoundingClientRect().top).toBeGreaterThan(statusBox.bottom)
    const action = canvas.getByRole("button", {
      name: "Link Atlassian account for Confluence",
    })
    expect(action.scrollHeight).toBeLessThanOrEqual(action.clientHeight)
  },
}

export const SyncFailed: Story = {
  parameters: {
    review: {
      purpose:
        "Connector row on the Connectors page, with health and actions for one connection: the content sync failed, the row is open.",
    },
  },
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
  parameters: {
    review: {
      purpose:
        "Connector row on the Connectors page, with health and actions for one connection: the configuration pull request failed, the row is open.",
    },
  },
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

/** The loading row has the same box as a collapsed connector row. */
export const ConnectorRowSkeletonMatches: Story = {
  parameters: {
    review: {
      purpose:
        "Proof frame for the Connectors page list: the loading skeleton row above a loaded, collapsed GitHub row, which must have the same box so the list does not jump.",
    },
    intent:
      "Catches a connector list skeleton row whose size differs from the loaded row. This causes layout shift. Not for connector data or health states.",
  },
  tags: ["required"],
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
