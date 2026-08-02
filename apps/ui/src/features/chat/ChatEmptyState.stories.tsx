import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { ChatEmptyState } from "./ChatEmptyState"

const meta = {
  title: "Components/Chat/EmptyState",
  component: ChatEmptyState,
  decorators: [
    (Story) => (
      <div className="w-[min(42rem,calc(100vw-2rem))] bg-zinc-950 p-8">
        <Story />
      </div>
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
    onPromptSelect: fn(),
  },
} satisfies Meta<typeof ChatEmptyState>

export default meta

type Story = StoryObj<typeof meta>

export const ReadyWithSuggestedQuestions: Story = {
  args: { availability: "ready" },
}

export const RepositoriesIndexing: Story = {
  args: { availability: "indexing" },
}

export const NoRepositories: Story = {
  args: { availability: "no-repositories" },
}

export const IndexingUnavailable: Story = {
  args: { availability: "unavailable" },
}

export const LoadingRepositories: Story = {
  args: { availability: "loading" },
}
