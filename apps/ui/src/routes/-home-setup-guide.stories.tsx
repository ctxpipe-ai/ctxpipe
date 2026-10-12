import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http, type RequestHandler } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import type { Workspace } from "@/features/workspaces/types"
import {
  docsWorkspace,
  docsWorkspaceDetail,
  emptyLinkedWorkspaceDetail,
  hydratingWorkspace,
} from "@/features/workspaces/workspace-fixtures"
import {
  authConfigHandler,
  githubInstallationLinkedHandler,
  githubInstallationNoneHandler,
  organizationInvitationsHandler,
  organizationListWithOrgHandler,
  organizationMembersHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import {
  workspaceDetailHandler,
  workspaceListHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OrgHomePageContent } from "./$orgSlug.index"

const DAY_MS = 24 * 60 * 60 * 1000
const userId = "user_storybook"

/** A signed-in user who finished onboarding `daysAgo` days ago. */
function sessionDefaults(daysAgo: number) {
  return [
    authConfigHandler,
    sessionSignedInHandler({
      id: userId,
      onboardingCompletedAt: new Date(
        Date.now() - daysAgo * DAY_MS,
      ).toISOString(),
    }),
    organizationListWithOrgHandler,
  ]
}

const bootstrapHosted = githubConnectorBootstrapHandler({
  orgSlug: "acme",
  hostedDefaultAppInstallUrl:
    "https://github.com/apps/ctxpipe-agent/installations/new",
})

function connectorsHandler(types: string[]) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.endsWith("/api/v1/connectors"),
    () =>
      HttpResponse.json({
        items: types.map((type, index) => ({
          id: `con_story_${index}`,
          type,
          displayName: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        })),
      }),
  )
}

const failed = (path: string) =>
  http.get(
    ({ request }) => new URL(request.url).pathname.endsWith(path),
    () => HttpResponse.json({ error: "failed" }, { status: 500 }),
  )

const owner = organizationMembersHandler([{ userId, role: "owner" }])

/** A new Workspace with no conversation of this user yet. */
const quietWorkspace: Workspace = {
  ...docsWorkspace,
  mostRecentConversationId: null,
}
const buildingWorkspace: Workspace = {
  ...hydratingWorkspace,
  mostRecentConversationId: null,
}

/** Workspace shell handlers come after the guide handlers, so these win. */
function homeHandlers(guide: RequestHandler[], workspaces?: Workspace[]) {
  return [...guide, ...workspaceShellHandlers({ workspaces })]
}

function clearPreferences() {
  window.localStorage.removeItem("ctxpipe:userPreferences")
}

const meta = {
  title: "Pages/Home/Setup guide",
  decorators: orgPageDecorators,
  beforeEach: clearPreferences,
  render: () => <OrgHomePageContent orgSlug="acme" />,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

async function findGuide(canvasElement: HTMLElement) {
  return within(
    await within(canvasElement).findByRole("region", { name: "Get started" }),
  )
}

/** A new admin with no Workspace: the guide takes the composer's place. */
export const GuideAdminNewOrg: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: [
          owner,
          organizationInvitationsHandler(),
          bootstrapHosted,
          githubInstallationNoneHandler,
          connectorsHandler([]),
          workspaceListHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText("0 of 6 done")).toBeVisible()
    expect(guide.getByText("Create your first Workspace")).toBeVisible()
    // One primary action: the first open row.
    expect(guide.getByRole("button", { name: "Connect GitHub" })).toBeVisible()
    const canvas = within(canvasElement)
    expect(canvas.queryByLabelText("Select workspace")).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create a workspace" }),
    ).not.toBeInTheDocument()
  },
}

/** GitHub is connected and the first Workspace still builds. */
export const GuideAdminWorkspaceBuilding: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          [
            owner,
            organizationInvitationsHandler(),
            bootstrapHosted,
            githubInstallationLinkedHandler,
            connectorsHandler(["github"]),
            workspaceDetailHandler({
              ...emptyLinkedWorkspaceDetail,
              ...buildingWorkspace,
            }),
          ],
          [buildingWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText("2 of 6 done")).toBeVisible()
    expect(guide.getByText("Building")).toBeVisible()
    expect(
      guide.getByText("You can ask questions while it builds."),
    ).toBeVisible()
    expect(
      guide.getByRole("button", { name: "Link repositories" }),
    ).toBeVisible()
    // The composer stays above the guide.
    expect(
      within(canvasElement).getByLabelText("Select workspace"),
    ).toBeVisible()
  },
}

/** After the first question the guide is one line. Expand still works. */
export const GuideAdminAfterFirstQuestion: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(2),
        page: homeHandlers(
          [
            owner,
            organizationInvitationsHandler(),
            bootstrapHosted,
            githubInstallationLinkedHandler,
            connectorsHandler(["github"]),
            workspaceDetailHandler(docsWorkspaceDetail),
          ],
          [docsWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText("4 of 6 done")).toBeVisible()
    const toggle = guide.getByRole("button", { name: "Get started" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(guide.getByText("Next")).toBeVisible()
    expect(guide.getByRole("button", { name: "Open Connectors" })).toBeVisible()
    const hiddenRow = guide.queryByText("Invite your team")
    if (hiddenRow) expect(hiddenRow).not.toBeVisible()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(guide.getByText("Invite your team")).toBeVisible()
    // The user's choice is kept for the next visit.
    const stored = JSON.parse(
      window.localStorage.getItem("ctxpipe:userPreferences") ?? "{}",
    )
    expect(stored.orgGuides[`${userId}:acme`]).toMatchObject({
      collapsed: false,
    })
  },
}

/** A member never sees GitHub, tool or invite rows. "Ask" fills the composer. */
export const GuideMemberView: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          [
            organizationMembersHandler([
              { userId: "user_owner", role: "owner" },
              { userId, role: "member" },
            ]),
          ],
          [quietWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText("0 of 2 done")).toBeVisible()
    expect(guide.getByText("Explore a Workspace")).toBeVisible()
    for (const title of [
      "Connect GitHub",
      "Connect a tool",
      "Invite your team",
      "Create your first Workspace",
    ]) {
      expect(guide.queryByText(title)).not.toBeInTheDocument()
    }
    await userEvent.click(guide.getByRole("button", { name: "Ask" }))
    const input = within(canvasElement).getByPlaceholderText(
      /what should ctxpipe do in this workspace/i,
    )
    await waitFor(() =>
      expect(input).toHaveValue("What should a new engineer read first?"),
    )
    expect(input).toHaveFocus()
  },
}

/** Every counted row is done: the complete line shows on this load. */
export const GuideAllDone: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(3),
        page: homeHandlers(
          [
            owner,
            organizationInvitationsHandler([
              { email: "teammate@story.example", role: "member" },
            ]),
            bootstrapHosted,
            githubInstallationLinkedHandler,
            connectorsHandler(["github", "linear"]),
            workspaceDetailHandler(docsWorkspaceDetail),
          ],
          [docsWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText(/Setup complete\./)).toBeVisible()
    expect(
      guide.getByText("This guide goes away on your next visit."),
    ).toBeVisible()
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("ctxpipe:userPreferences") ?? "{}",
      )
      expect(stored.orgGuides?.[`${userId}:acme`]?.completedAt).toBeTruthy()
    })
  },
}

/** Dismiss removes the guide, and Home stays. */
export const GuideDismissRemovesIt: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          [
            owner,
            organizationInvitationsHandler(),
            bootstrapHosted,
            githubInstallationNoneHandler,
            connectorsHandler([]),
            workspaceDetailHandler(emptyLinkedWorkspaceDetail),
          ],
          [quietWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    await userEvent.click(guide.getByRole("button", { name: "Dismiss" }))
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Get started" }),
      ).not.toBeInTheDocument(),
    )
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
  },
}

/** Failed signal queries count as "not done". Home still works. */
export const GuideSignalFailureKeepsHome: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          [
            owner,
            organizationInvitationsHandler(),
            bootstrapHosted,
            failed("/api/v1/github/installation"),
            failed("/api/v1/connectors"),
            workspaceDetailHandler(docsWorkspaceDetail),
          ],
          [docsWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText("3 of 6 done")).toBeVisible()
    const canvas = within(canvasElement)
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    expect(await canvas.findByText("Activity")).toBeVisible()
  },
}

/** While a signal query is pending, the guide shows nothing (no wrong count). */
export const GuideSignalsPending: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          [
            http.get(
              "*/.auth/api/v1/auth/organization/list-members",
              async () => {
                await delay("infinite")
                return HttpResponse.json({ members: [], total: 0 })
              },
            ),
          ],
          [docsWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(await canvas.findByText("Activity")).toBeVisible()
    expect(
      canvas.queryByRole("region", { name: "Get started" }),
    ).not.toBeInTheDocument()
  },
}

/** Onboarding finished more than 14 days ago: no guide at all. */
export const GuideEstablishedUserHidden: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(30),
        page: homeHandlers(
          [
            owner,
            organizationInvitationsHandler(),
            bootstrapHosted,
            githubInstallationNoneHandler,
            connectorsHandler([]),
            workspaceDetailHandler(emptyLinkedWorkspaceDetail),
          ],
          [quietWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(await canvas.findByText("Activity")).toBeVisible()
    // Give the guide signals time to settle before the check.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(
      canvas.queryByRole("region", { name: "Get started" }),
    ).not.toBeInTheDocument()
  },
}
