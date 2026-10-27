import type { Meta, StoryObj } from "@storybook/react-vite"

import { AppShell } from "@/components/AppShell"
import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { GithubWorkspaceDestination } from "./GithubWorkspaceDestination"
import { docsWorkspace, readOnlyWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/GithubDestination",
  component: GithubWorkspaceDestination,
  decorators: [
    (Story) => (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <Story />
        </main>
      </AppShell>
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
  args: {
    variant: "page",
    onCreateWorkspace: () => undefined,
    onSelectWorkspace: () => undefined,
    onClose: () => undefined,
    onRetry: () => undefined,
  },
} satisfies Meta<typeof GithubWorkspaceDestination>

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: {
    status: "ready",
    workspaces: [],
  },
}

export const Loading: Story = {
  args: {
    status: "loading",
    workspaces: [],
  },
}

export const LoadError: Story = {
  args: {
    status: "error",
    workspaces: [],
  },
}

export const Populated: Story = {
  args: {
    status: "ready",
    workspaces: [docsWorkspace, readOnlyWorkspace],
  },
}

export const OnboardingEmpty: Story = {
  args: {
    variant: "onboarding",
    status: "ready",
    workspaces: [],
  },
}

/**
 * The loading skeleton has the same box as the page with three workspaces:
 * the button, the cards and the close button.
 */
export const LoadingSkeletonMatches: Story = {
  parameters: {
    intent:
      "Catches a workspace destination skeleton whose size differs from the loaded list. This causes layout shift. Not for workspace data or selection.",
  },
  tags: ["workspace-golden"],
  args: {
    status: "loading",
    workspaces: [],
  },
  render: (args) => (
    <SkeletonMatchFrame
      skeleton={<GithubWorkspaceDestination {...args} status="loading" />}
      loaded={
        <GithubWorkspaceDestination
          {...args}
          status="ready"
          workspaces={[
            docsWorkspace,
            readOnlyWorkspace,
            { ...docsWorkspace, id: "ws_third", slug: "third" },
          ]}
        />
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await expectSkeletonMatchesLoaded(canvasElement)
  },
}
