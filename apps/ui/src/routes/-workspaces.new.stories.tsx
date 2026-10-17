import type { Meta, StoryObj } from "@storybook/react-vite"
import { useLocation } from "@tanstack/react-router"
import { delay, http } from "msw"
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
  workspaceCreateHandler,
  workspaceDetailHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import {
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
    expect(canvas.getByText("Loading new workspace")).toBeInTheDocument()
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
  workspaceCreateHandler(createdWorkspace),
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
  http.get("*/.auth/api/v1/auth/get-session", async () => {
    await delay(1500)
  }),
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
  render: () => (
    <>
      <NewWorkspacePageContent orgSlug={orgSlug} />
      <LocationProbe />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Add repositories" })
    await expect(
      canvas.getByText("Add code repositories and tools").closest("li"),
    ).toHaveAttribute("aria-current", "step")
    // Step 1 is gone: its form is not on the page, and no Workspace is created.
    await expect(
      canvas.queryByRole("button", { name: "Create Workspace" }),
    ).toBeNull()
    await expect(canvas.queryByRole("tab", { name: /paste url/i })).toBeNull()
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
  },
}

/** The step 1 form stays out of step 2 and does not create a second Workspace. */
export const NoSecondCreate: Story = {
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
    await canvas.findByRole("button", { name: "Open Workspace" })
    await expect(
      canvas.queryByRole("list", { name: /repositories/i }),
    ).toBeNull()
  },
}

/** Step 2 for a repository that already had files: it has no format file yet. */
export const StepTwoNeedsUpgrade: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
      search: "?workspace=handbook",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          // The first matching handler answers, so this one comes first.
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 0 })),
          ...stepTwoHandlers,
        ],
      },
    },
  },
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Upgrade this Workspace before you add sources")
    await expect(
      canvas.getByRole("button", { name: "Review upgrades" }),
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
    await expect(
      canvas.getByRole("button", { name: "Open Workspace" }),
    ).toBeVisible()
  },
}

/** A new empty repository: the format file lands a few seconds after the create. */
export const StepTwoWaitsForFormat: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
      search: "?workspace=handbook",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          // The first read has no format yet; the next reads have format 3.
          // The first matching handler answers, so this one comes first.
          workspaceUpgradesHandler(
            (() => {
              let reads = 0
              return () =>
                upgradesFixture([], {
                  formatVersion: reads++ === 0 ? null : 3,
                })
            })(),
          ),
          ...stepTwoHandlers,
        ],
      },
    },
  },
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
    // The session has not answered: the page shows the session fallback.
    await waitFor(
      () => expect(canvas.getByText("Loading new workspace")).toBeVisible(),
      { timeout: 15_000 },
    )
    await measure()
    // Step 1 while the repository list loads.
    await canvas.findByText("Loading repositories", {}, { timeout: 5000 })
    await measure()
    // Step 1 with the list loaded.
    await userEvent.click(
      await canvas.findByRole(
        "radio",
        { name: /acme\/handbook/ },
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
      { timeout: 5000 },
    )
    await measure()
    for (const place of seen) expect(place).toEqual(seen[0])
  },
}
