import type { Meta, StoryObj } from "@storybook/react-vite"
import { AppShell } from "@/components/AppShell"
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
