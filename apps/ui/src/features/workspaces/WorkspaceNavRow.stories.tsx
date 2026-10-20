import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { conversationsListHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceNavRow } from "./WorkspaceNavRow"
import {
  docsConversations,
  docsWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/NavRow",
  component: WorkspaceNavRow,
  decorators: [
    (Story) => (
      <ul className="w-64 bg-zinc-950 py-2">
        <Story />
      </ul>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspace,
    workspaceCount: 2,
    navExpanded: true,
    collapsible: true,
    open: false,
    current: false,
    onToggle: fn(),
    onExpand: fn(),
    onSelectNav: fn(),
  },
} satisfies Meta<typeof WorkspaceNavRow>

export default meta

type Story = StoryObj<typeof meta>

export const MultipleWorkspaces: Story = {
  render: (args) => (
    <>
      <WorkspaceNavRow {...args} current />
      <WorkspaceNavRow
        {...args}
        workspace={readOnlyWorkspace}
        current={false}
      />
    </>
  ),
}

export const SingleWorkspace: Story = {
  args: {
    workspaceCount: 1,
    collapsible: false,
    current: true,
  },
}

export const CollapsedNav: Story = {
  args: {
    navExpanded: false,
    current: true,
  },
}

export const OpenWithConversations: Story = {
  args: {
    open: true,
    current: true,
    currentConversationId: "conv_1",
  },
  parameters: {
    msw: {
      handlers: {
        page: [conversationsListHandler(docsConversations)],
      },
    },
  },
}
