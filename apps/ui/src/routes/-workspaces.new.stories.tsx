import type { Meta, StoryObj } from "@storybook/react-vite"
import { useLocation } from "@tanstack/react-router"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  createdWorkspace,
  createdWritableWorkspaceDetail,
} from "@/features/workspaces/workspace-fixtures"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import {
  githubInstallationReposHandler,
  orgGithubConnectionsHandler,
  workspaceDetailHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import {
  NewWorkspaceGate,
  NewWorkspacePageContent,
  NewWorkspaceSessionFallback,
} from "./$orgSlug.workspaces.new"

const orgSlug = "acme"

const meta = {
  title: "Pages/Workspaces/New",
  decorators: orgPageDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        // Only an owner or admin sees the repository pickers.
        role: [activeMemberRoleHandler("owner")],
        page: [
          workspaceListHandler([]),
          orgGithubConnectionsHandler(),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  render: () => <NewWorkspaceSessionFallback />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    // Step 1 shows its own intro and its repository skeleton.
    expect(canvas.getByText(/saves this Workspace’s knowledge/)).toBeVisible()
    expect(canvas.getByText("Loading repositories")).toBeInTheDocument()
  },
}

export const PasteUrl: Story = {
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
  },
}

export const SelectGitHub: Story = {
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
  },
}

export const CreateOnGitHub: Story = {
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
  },
}

/** How many Workspaces the story created, as the API saw it. */
const creates = { count: 0 }

/**
 * Step 2 needs the new Workspace, its sources, a GitHub connection, and a
 * Workspace repository that is ready for sources (format 3).
 */
const stepTwoHandlers = [
  workspaceListHandler([]),
  orgConnectionsHandler([
    { id: "con_gh", type: "github", displayName: "acme" },
  ]),
  githubInstallationReposHandler(),
  http.post(
    ({ request }) =>
      /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
    () => {
      creates.count += 1
      return HttpResponse.json(createdWorkspace, { status: 201 })
    },
  ),
  workspaceSourcesHandler(workspaceSourceList()),
  workspaceDetailHandler(createdWritableWorkspaceDetail),
  workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
]

/** Shows the search string of the router, so a play can read it. */
function LocationProbe() {
  const searchStr = useLocation({ select: (location) => location.searchStr })
  return <output data-testid="location-search">{searchStr}</output>
}

/** A request that waits `ms`, then goes on to the next handler. */
function slowAnswer(match: (pathname: string) => boolean, ms: number) {
  return http.get(
    ({ request }) => match(new URL(request.url).pathname),
    async () => {
      await delay(ms)
    },
  )
}

/** The session answers late, so the page shows its session fallback first. */
const slowSessionDefaults = [
  authConfigHandler,
  slowAnswer((path) => path.endsWith("/.auth/api/v1/auth/get-session"), 1500),
  sessionSignedInHandler({
    id: "user_storybook",
    onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
  }),
  organizationListWithOrgHandler,
]

/** Opened at the URL that Add Workspace uses once the Workspace exists. */
export const StepTwoFromUrl: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
      search: "?workspace=handbook",
    } satisfies StoryRouteParams,
    msw: { handlers: { page: stepTwoHandlers } },
  },
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    creates.count = 0
    await canvas.findByRole("button", { name: "Add repositories" })
    await expect(
      canvas.getByText("Add code repositories and tools").closest("li"),
    ).toHaveAttribute("aria-current", "step")
    // Step 1 is gone: its form is not on the page, and no Workspace is created.
    await expect(
      canvas.queryByRole("button", { name: "Create Workspace" }),
    ).toBeNull()
    await expect(canvas.queryByRole("tab", { name: /paste url/i })).toBeNull()
    expect(creates.count).toBe(0)
  },
}

/** Create a Workspace in step 1: the URL changes, and step 2 shows. */
export const CreateMovesToStepTwoUrl: Story = {
  parameters: { msw: { handlers: { page: stepTwoHandlers } } },
  render: () => (
    <>
      <NewWorkspacePageContent orgSlug={orgSlug} />
      <LocationProbe />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    creates.count = 0
    await userEvent.click(
      await canvas.findByRole("radio", { name: /acme\/handbook/ }),
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create Workspace" }),
    )
    await canvas.findByRole("button", { name: "Add repositories" })
    await waitFor(() =>
      expect(canvas.getByTestId("location-search")).toHaveTextContent(
        "?workspace=handbook",
      ),
    )
    expect(creates.count).toBe(1)
  },
}

/** The user opens a link for a Workspace that does not exist (or is not theirs). */
export const UnknownWorkspaceInUrl: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
      search: "?workspace=missing",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceDetailHandler(null), ...stepTwoHandlers],
      },
    },
  },
  render: () => (
    <>
      <NewWorkspacePageContent orgSlug={orgSlug} />
      <LocationProbe />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Workspace not found")
    await userEvent.click(canvas.getByRole("button", { name: "Start again" }))
    // Step 1 is back, and the URL no longer names the missing Workspace.
    await canvas.findByRole("list", { name: /repositories/i })
    await expect(
      canvas.getByText("Choose the Workspace repository").closest("li"),
    ).toHaveAttribute("aria-current", "step")
    await waitFor(() =>
      expect(canvas.getByTestId("location-search")).toHaveTextContent(/^$/),
    )
  },
}

/**
 * A reload at the step 2 URL: the session fallback already shows step 2, so
 * step 1 never flashes before it.
 */
export const LoadingStepTwo: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
      search: "?workspace=handbook",
    } satisfies StoryRouteParams,
    msw: {
      handlers: { defaults: slowSessionDefaults, page: stepTwoHandlers },
    },
  },
  render: () => <NewWorkspaceGate orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The session answers after 1500 ms, so this is the session fallback.
    await expect(
      canvas.getByText("Add code repositories and tools").closest("li"),
    ).toHaveAttribute("aria-current", "step")
    await expect(canvas.queryByText("Loading repositories")).toBeNull()
    await canvas.findByRole(
      "button",
      { name: "Add repositories" },
      // The 1500 ms delayed session answer comes first.
      { timeout: 5000 },
    )
    await expect(
      canvas.getByText("Add code repositories and tools").closest("li"),
    ).toHaveAttribute("aria-current", "step")
  },
}

/** How many times a story has read the upgrades of the Workspace. */
const upgradeReads = { count: 0 }

/** Step 2 with the upgrades read of a story, ahead of the default one. */
function stepTwoWith(upgradesHandler: ReturnType<typeof http.get>) {
  return {
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
      search: "?workspace=handbook",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        // The first matching handler answers, so the story handler comes first.
        page: [upgradesHandler, ...stepTwoHandlers],
      },
    },
  }
}

/** Step 2 for a repository that already had files: it has no format file yet. */
export const StepTwoNeedsUpgrade: Story = {
  parameters: stepTwoWith(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 0 })),
  ),
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement, loaded }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Upgrade this Workspace before you add sources")
    // A member cannot start the upgrade, so the text names who does.
    await expect(canvas.getByText(/An owner or admin starts/)).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
    await expect(
      canvas.getByRole("button", { name: "Open Workspace" }),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Review upgrades" }),
    )
    // The Workspace settings open, where the upgrades are.
    const { router } = loaded.storyRoute
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/acme/ws/handbook")
      expect(router.state.location.search).toMatchObject({ pane: "settings" })
    })
  },
}

/** The format file is not valid: an upgrade does not fix it, so no upgrade text. */
export const StepTwoFormatNotValid: Story = {
  parameters: stepTwoWith(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: -1 })),
  ),
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/^The format file in the repository is not valid\./)
    await expect(
      canvas.queryByText("Upgrade this Workspace before you add sources"),
    ).toBeNull()
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
  },
}

/** The repository has a newer format than ctxpipe reads: the Workspace is read-only. */
export const StepTwoFormatAhead: Story = {
  parameters: stepTwoWith(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 4 })),
  ),
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/This Workspace needs a newer ctxpipe version/)
    await expect(
      canvas.queryByText("Upgrade this Workspace before you add sources"),
    ).toBeNull()
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
  },
}

/** The first read of the upgrades fails: Retry reads again, and sources show. */
export const StepTwoUpgradesReadFails: Story = {
  beforeEach: () => {
    upgradeReads.count = 0
  },
  parameters: stepTwoWith(
    http.get(
      ({ request }) =>
        /\/workspaces\/[^/]+\/upgrades$/.test(new URL(request.url).pathname),
      () =>
        upgradeReads.count++ === 0
          ? HttpResponse.json({ error: "Server error" }, { status: 500 })
          : HttpResponse.json(upgradesFixture([], { formatVersion: 3 })),
    ),
  ),
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Could not load the Workspace")
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await canvas.findByRole("button", { name: "Add repositories" })
    await waitFor(() =>
      expect(canvas.queryByText("Could not load the Workspace")).toBeNull(),
    )
  },
}

/** A new empty repository: the format file lands a few seconds after the create. */
export const StepTwoWaitsForFormat: Story = {
  beforeEach: () => {
    upgradeReads.count = 0
  },
  parameters: stepTwoWith(
    // The first read has no format yet; the next reads have format 3.
    workspaceUpgradesHandler(() =>
      upgradesFixture([], {
        formatVersion: upgradeReads.count++ === 0 ? null : 3,
      }),
    ),
  ),
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Setting up the Workspace repository")
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
    await canvas.findByRole(
      "button",
      { name: "Add repositories" },
      // The step polls the format every 2 s while it is not known.
      { timeout: 6000 },
    )
    await expect(
      canvas.queryByText("Setting up the Workspace repository"),
    ).toBeNull()
  },
}

type Placement = { heading: number; card: number }

/** The top of the heading and of the step card, in page pixels. */
function placement(canvas: ReturnType<typeof within>): Placement {
  const heading = canvas.getByRole("heading", { name: "Add Workspace" })
  const card = canvas.getByRole("region", {
    name: /Choose the Workspace repository|Add code repositories and tools/,
  })
  return {
    heading: heading.getBoundingClientRect().top,
    card: card.getBoundingClientRect().top,
  }
}

/**
 * The heading and the step card keep their top while the page loads and the
 * user goes from step 1 to step 2.
 */
export const KeepsPlaceBetweenSteps: Story = {
  tags: ["workspace-golden"],
  parameters: {
    intent:
      "Catches layout shift between the loading skeleton and the loaded steps of the new workspace page. The step keeps its place while data loads. Not for step content.",
    msw: {
      handlers: {
        defaults: slowSessionDefaults,
        page: [
          // The repository list and the new Workspace load slowly.
          slowAnswer(
            (path) => path.endsWith("/api/v1/github/installation/repositories"),
            1500,
          ),
          slowAnswer(
            (path) => /\/api\/v1\/workspaces\/[^/]+$/.test(path),
            1500,
          ),
          ...stepTwoHandlers,
        ],
      },
    },
  },
  render: () => <NewWorkspaceGate orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const seen: Placement[] = []
    const measure = async () => {
      await document.fonts.ready
      seen.push(placement(canvas))
    }
    /** The box of the repository skeleton (the parent of its screen reader text). */
    const skeletonBox = () => {
      const box = canvas
        .getByText("Loading repositories")
        .parentElement?.getBoundingClientRect()
      return box && { top: box.top, width: box.width, height: box.height }
    }
    // The session has not answered: the page shows the session fallback, with
    // the repository skeleton of step 1.
    const fallbackSkeleton = await canvas.findByText("Loading repositories")
    await measure()
    const fallbackBox = skeletonBox()
    // The 1500 ms delayed session answer: the form mounts, and its own
    // skeleton replaces the one of the fallback.
    await waitFor(() => expect(fallbackSkeleton.isConnected).toBe(false), {
      timeout: 5000,
    })
    // Step 1 while the repository list loads.
    await canvas.findByText("Loading repositories")
    // The two skeletons are one chain: the second shows at once, with no
    // new delay, so the card does not go blank in between.
    expect(
      getComputedStyle(
        canvas
          .getByText("Loading repositories")
          .parentElement?.querySelector("[data-skeleton]") as Element,
      ).visibility,
    ).toBe("visible")
    await measure()
    expect(skeletonBox()).toEqual(fallbackBox)
    // Step 1 with the list loaded.
    await userEvent.click(
      await canvas.findByRole(
        "radio",
        { name: /acme\/handbook/ },
        // The 1500 ms delayed repository list.
        { timeout: 5000 },
      ),
    )
    await measure()
    await userEvent.click(
      canvas.getByRole("button", { name: "Create Workspace" }),
    )
    // Step 2 while the Workspace loads.
    await canvas.findByText("Checking write access")
    await measure()
    // Step 2 with the sources loaded.
    await canvas.findByRole(
      "button",
      { name: "Add repositories" },
      // The 1500 ms delayed Workspace answer.
      { timeout: 5000 },
    )
    await measure()
    for (const place of seen) expect(place).toEqual(seen[0])
  },
}
