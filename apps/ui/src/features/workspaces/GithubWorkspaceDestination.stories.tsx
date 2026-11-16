import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor, within } from "storybook/test"

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
    review: { kind: "page" },
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
  parameters: {
    review: {
      purpose:
        "GitHub destination page in the app shell, where a member picks or creates a Workspace: the org has no Workspaces yet.",
    },
  },
}

export const Loading: Story = {
  args: {
    status: "loading",
    workspaces: [],
  },
  parameters: {
    review: {
      purpose:
        "GitHub destination page in the app shell, where a member picks or creates a Workspace: the Workspace list is loading.",
    },
  },
}

export const LoadError: Story = {
  args: {
    status: "error",
    workspaces: [],
  },
  parameters: {
    review: {
      purpose:
        "GitHub destination page in the app shell, where a member picks or creates a Workspace: the Workspace list did not load.",
    },
  },
}

export const Populated: Story = {
  args: {
    status: "ready",
    workspaces: [docsWorkspace, readOnlyWorkspace],
  },
  parameters: {
    review: {
      purpose:
        "GitHub destination page in the app shell, where a member picks or creates a Workspace: the org has two Workspaces, and one is read-only.",
    },
  },
}

/**
 * GitHub came back after a change of repository access. The page says that
 * access changed and says where to add a repository. It is not a wizard
 * (CTX-1118).
 */
export const AccessUpdated: Story = {
  args: {
    status: "ready",
    accessUpdated: true,
    workspaces: [docsWorkspace, readOnlyWorkspace],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "GitHub access updated" })
    await waitFor(() => {
      expect(
        canvas.getByText(
          "ctxpipe can read the repositories that you selected on GitHub. To add one to a workspace, select the workspace, then select Add repositories.",
        ),
      ).toBeVisible()
      expect(canvas.getByRole("button", { name: "Close" })).toBeVisible()
      expect(canvas.queryByText(/wizard/)).toBeNull()
    })
  },
}

export const OnboardingEmpty: Story = {
  args: {
    variant: "onboarding",
    status: "ready",
    workspaces: [],
  },
  parameters: {
    review: {
      purpose:
        "GitHub destination in the onboarding layout, where a new member creates a first Workspace: the org has no Workspaces yet.",
    },
  },
}

/**
 * The loading skeleton has the same box as the page with three workspaces:
 * the button, the cards and the close button.
 */
export const LoadingSkeletonMatches: Story = {
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    intent:
      "Catches a workspace destination skeleton whose size differs from the loaded list. This causes layout shift. Not for workspace data or selection.",
    review: {
      kind: "component",
      purpose:
        "Loading skeleton of the GitHub destination next to its loaded list of three Workspaces: the two boxes must have the same size.",
    },
  },
  tags: ["required"],
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
