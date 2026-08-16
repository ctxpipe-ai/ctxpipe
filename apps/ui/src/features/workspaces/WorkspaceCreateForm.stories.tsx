import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceCreateForm } from "./WorkspaceCreateForm"

const meta = {
  title: "Components/Workspaces/CreateForm",
  component: WorkspaceCreateForm,
  decorators: [
    (Story) => (
      <div className="min-h-[28rem] bg-zinc-950 px-6 py-16">
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
  },
  args: { orgSlug: "acme" },
} satisfies Meta<typeof WorkspaceCreateForm>

export default meta

type Story = StoryObj<typeof meta>

export const ZeroWorkspaces: Story = {}
