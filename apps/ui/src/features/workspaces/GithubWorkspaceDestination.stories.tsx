import { AppShell } from "@/components/AppShell"
import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
import { signedInHandlers } from "@/mocks/handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { GithubWorkspaceDestination } from "./GithubWorkspaceDestination"
import { docsWorkspace, readOnlyWorkspace } from "./workspace-fixtures"

const meta = preview.meta({
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
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, ...workspaceIngestionHandlers({}))
  },
  parameters: {
    app: "root",
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
})

/**
 * GitHub destination page in the app shell, where a member picks or creates a
 * Workspace: the org has no Workspaces yet.
 */
export const Empty = meta.story({
  args: {
    status: "ready",
    workspaces: [],
  },
  beforeEach: ({ msw }) => {
    // The app shell lists the same Workspaces as the page.
    msw.use(workspaceListHandler([]))
  },
})

/**
 * GitHub setup page after GitHub connects, where a member creates a Workspace
 * or opens one to add repositories: the Workspace list still loads, so skeleton
 * rows show.
 */
export const Loading = meta.story({
  args: {
    status: "loading",
    workspaces: [],
  },
  beforeEach: ({ msw }) => {
    // The app shell lists the same Workspaces as the page.
    msw.use(workspaceListHandler("loading"))
  },
})

/**
 * GitHub destination page in the app shell, where a member picks or creates a
 * Workspace: the Workspace list did not load.
 */
export const LoadError = meta.story({
  args: {
    status: "error",
    workspaces: [],
  },
  beforeEach: ({ msw }) => {
    // The app shell lists the same Workspaces as the page.
    msw.use(workspaceListHandler("error"))
  },
})

/** A second Workspace that keeps its knowledge in its own repository. */
const handbookWorkspace = {
  ...docsWorkspace,
  id: "ws_handbook",
  slug: "handbook",
  displayName: "Handbook",
  workspaceRepositoryUrl: "https://github.com/acme/handbook",
}

/**
 * GitHub setup page after GitHub connects, where a member creates a Workspace
 * or opens one to add repositories: the org has two Workspaces, each row opens
 * its settings.
 */
export const Populated = meta.story({
  args: {
    status: "ready",
    workspaces: [docsWorkspace, handbookWorkspace],
  },
  beforeEach: ({ msw }) => {
    // The app shell lists the same Workspaces as the page.
    msw.use(workspaceListHandler([docsWorkspace, handbookWorkspace]))
  },
})

/**
 * GitHub destination in the onboarding layout, where a new member creates a
 * first Workspace: the org has no Workspaces yet.
 */
export const OnboardingEmpty = meta.story({
  args: {
    variant: "onboarding",
    status: "ready",
    workspaces: [],
  },
  beforeEach: ({ msw }) => {
    // The app shell lists the same Workspaces as the page.
    msw.use(workspaceListHandler([]))
  },
})

/**
 * Loading skeleton of the GitHub destination, next to its loaded list of three
 * Workspaces. The two boxes must have the same size: the button, the cards, and
 * the close button.
 */
export const LoadingSkeletonMatches = meta.story({
  beforeEach: ({ msw }) => {
    // The app shell lists the same Workspaces as the page.
    msw.use(workspaceListHandler("loading"))
  },
  parameters: {
    intent:
      "Catches a workspace destination skeleton whose size differs from the loaded list. This causes layout shift. Not for workspace data or selection.",
    review: {
      kind: "component",
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
})
