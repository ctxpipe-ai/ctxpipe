import type { Meta, StoryObj } from "@storybook/react-vite"
import { IconBrandGithub } from "@tabler/icons-react"
import { ConnectorListItem, ConnectorRemoveMenu } from "./ConnectorListItem"

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
  menu: (
    <ConnectorRemoveMenu
      ariaLabel="GitHub connector actions"
      onRemove={() => {}}
    />
  ),
  workspace: "acme",
  scope: "12 repositories",
  syncRepository: "—",
  actionLabel: "Manage repositories",
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

export const NotYetConnected: Story = {
  args: {
    ...shared,
    health: "not_connected",
    workspace: "—",
    scope: "0 selected items",
    actionLabel: "Continue setup",
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
    scope: "—",
    actionLabel: undefined,
    onAction: undefined,
  },
}
