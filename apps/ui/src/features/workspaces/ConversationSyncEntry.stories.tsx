import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import { ConversationSyncEntry } from "./ConversationSyncEntry"
import type { ConversationSync } from "./types"

const branch = "ctxpipe/chat/conv_1/1"
const treeUrl = `https://github.com/acme/docs/tree/${branch}`
const pullUrl = "https://github.com/acme/docs/pull/12"

const base: ConversationSync = {
  trigger: "sync",
  branch,
  sha: "8eb1704c2d1f0a5b6e3c9d7f4a2b1c0d9e8f7a6b",
  files: 3,
  treeUrl,
  turn: 1,
  syncedAt: "2026-08-16T10:05:00.000Z",
}

const meta = {
  title: "Components/Workspaces/ConversationSyncEntry",
  component: ConversationSyncEntry,
  decorators: [
    (Story) => (
      <div className="w-[40rem] bg-background p-4">
        <Story />
      </div>
    ),
  ],
  args: { sync: base },
} satisfies Meta<typeof ConversationSyncEntry>

export default meta

type Story = StoryObj<typeof meta>

/** Each link opens GitHub in a new tab and tells so in its name. */
async function expectLink(entry: HTMLElement, name: string, href: string) {
  const link = within(entry).getByRole("link", {
    name: `${name} on GitHub (opens in a new tab)`,
  })
  await expect(link).toHaveAttribute("href", href)
  await expect(link).toHaveAttribute("target", "_blank")
}

export const SyncEntry: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const entry = within(canvasElement).getByRole("region", {
      name: `Synced 3 files to ${branch}`,
    })
    await expectLink(entry, branch, treeUrl)
  },
}

export const CreatePrEntry: Story = {
  tags: ["workspace-golden"],
  args: {
    sync: {
      ...base,
      trigger: "create_pr",
      pullRequest: { number: 12, url: pullUrl, opened: true },
    },
  },
  play: async ({ canvasElement }) => {
    const entry = within(canvasElement).getByRole("region", {
      name: `Pushed 3 files to ${branch} and opened PR #12`,
    })
    await expectLink(entry, branch, treeUrl)
    await expectLink(entry, "PR #12", pullUrl)
  },
}

export const ExistingPrEntry: Story = {
  tags: ["workspace-golden"],
  args: {
    sync: {
      ...base,
      trigger: "create_pr",
      files: 1,
      pullRequest: { number: 12, url: pullUrl, opened: false },
    },
  },
  play: async ({ canvasElement }) => {
    const entry = within(canvasElement).getByRole("region", {
      name: `Pushed 1 file to ${branch} for PR #12`,
    })
    await expectLink(entry, "PR #12", pullUrl)
  },
}

/** The push succeeded, but GitHub did not open the pull request. */
export const CreatePrWithoutPrEntry: Story = {
  tags: ["workspace-golden"],
  args: { sync: { ...base, trigger: "create_pr" } },
  play: async ({ canvasElement }) => {
    const entry = within(canvasElement).getByRole("region", {
      name: `Pushed 3 files to ${branch}`,
    })
    await expectLink(entry, branch, treeUrl)
    await expect(within(entry).getAllByRole("link")).toHaveLength(1)
  },
}

export const AgentPushEntry: Story = {
  tags: ["workspace-golden"],
  args: { sync: { ...base, trigger: "agent" } },
  play: async ({ canvasElement }) => {
    const entry = within(canvasElement).getByRole("region", {
      name: `The agent pushed 3 files to ${branch}`,
    })
    await expectLink(entry, branch, treeUrl)
  },
}

export const SweepPushEntry: Story = {
  tags: ["workspace-golden"],
  args: { sync: { ...base, trigger: "sweep", files: 2 } },
  play: async ({ canvasElement }) => {
    const entry = within(canvasElement).getByRole("region", {
      name: `ctx| pushed 2 files to ${branch}`,
    })
    await expectLink(entry, branch, treeUrl)
  },
}
