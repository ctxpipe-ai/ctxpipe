import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http, type RequestHandler } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { responseGate } from "@/components/ui/skeletonMatchStory"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import type { Workspace, WorkspaceDetail } from "@/features/workspaces/types"
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
  organizationListHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import {
  orgActivityHandler,
  workspaceDetailHandler,
  workspaceListHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OrgHomePageContent } from "./$orgSlug.index"

const DAY_MS = 24 * 60 * 60 * 1000
const userId = "user_storybook"
const authBase = "*/.auth/api/v1/auth"

/**
 * A signed-in user who finished onboarding `daysAgo` days ago, in an
 * organization created `orgDaysAgo` days ago.
 */
function sessionDefaults(daysAgo: number, orgDaysAgo = 365) {
  return [
    authConfigHandler,
    sessionSignedInHandler({
      id: userId,
      onboardingCompletedAt: new Date(
        Date.now() - daysAgo * DAY_MS,
      ).toISOString(),
    }),
    organizationListHandler([
      {
        id: "org_storybook",
        name: "Storybook Org",
        slug: "acme",
        createdAt: new Date(Date.now() - orgDaysAgo * DAY_MS).toISOString(),
      },
    ]),
  ]
}

/** `GET .../organization/get-active-member-role`: `{ role }`. */
function roleHandler(role: string) {
  return http.get(`${authBase}/organization/get-active-member-role`, () =>
    HttpResponse.json({ role }),
  )
}

/** `GET .../organization/list-members` in the Better Auth response shape. */
function membersHandler(count: number) {
  return http.get(`${authBase}/organization/list-members`, () =>
    HttpResponse.json({
      members: Array.from({ length: count }, (_, index) => ({
        id: `mem_story_${index}`,
        organizationId: "org_storybook",
        userId: index === 0 ? userId : `user_story_${index}`,
        role: index === 0 ? "owner" : "member",
        createdAt: "2026-10-01T00:00:00.000Z",
        user: {
          id: index === 0 ? userId : `user_story_${index}`,
          name: "Storybook User",
          email: `member${index}@story.example`,
          image: null,
        },
      })),
      total: count,
    }),
  )
}

/** `GET .../organization/list-invitations`: an array of invitations. */
function invitationsHandler(statuses: string[]) {
  return http.get(`${authBase}/organization/list-invitations`, () =>
    HttpResponse.json(
      statuses.map((status, index) => ({
        id: `inv_story_${index}`,
        organizationId: "org_storybook",
        email: `teammate${index}@story.example`,
        role: "member",
        status,
        inviterId: userId,
        expiresAt: "2026-12-01T00:00:00.000Z",
        createdAt: "2026-10-01T00:00:00.000Z",
      })),
    ),
  )
}

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

/** The guide signals of an owner. Each field replaces one signal. */
function adminGuide(input: {
  github?: RequestHandler
  connectors?: RequestHandler
  invitations?: string[]
  detail?: WorkspaceDetail
}) {
  return [
    roleHandler("owner"),
    membersHandler(1),
    invitationsHandler(input.invitations ?? []),
    githubConnectorBootstrapHandler({
      orgSlug: "acme",
      hostedDefaultAppInstallUrl:
        "https://github.com/apps/ctxpipe-agent/installations/new",
    }),
    input.github ?? githubInstallationNoneHandler,
    input.connectors ?? connectorsHandler([]),
    workspaceDetailHandler(input.detail ?? emptyLinkedWorkspaceDetail),
  ]
}

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
function homeHandlers(guide: RequestHandler[], workspaces: Workspace[]) {
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

/**
 * A new admin with no Workspace: the guide takes the composer's place, and
 * the activity of the organization shows below it, empty.
 */
export const GuideAdminNewOrg: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: [
          ...adminGuide({}),
          workspaceListHandler([]),
          orgActivityHandler(),
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
    await waitFor(() => expect(canvas.getByText("Activity")).toBeVisible())
    await waitFor(() =>
      expect(
        canvas.getByText("No commits on the default branch yet."),
      ).toBeVisible(),
    )
  },
}

/** GitHub is connected and the first Workspace still builds. */
export const GuideAdminWorkspaceBuilding: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github"]),
            detail: { ...emptyLinkedWorkspaceDetail, ...buildingWorkspace },
          }),
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
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github"]),
            detail: docsWorkspaceDetail,
          }),
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
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"))
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
        page: homeHandlers([roleHandler("member")], [quietWorkspace]),
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
    const composer = () =>
      within(canvasElement).getByPlaceholderText(
        /what should ctxpipe do in this workspace/i,
      )
    // Ask fills the composer and focuses it, also on a second press.
    for (const _press of [1, 2]) {
      await userEvent.clear(composer())
      await userEvent.click(guide.getByRole("button", { name: "Ask" }))
      await waitFor(() =>
        expect(composer()).toHaveValue(
          "What should a new engineer read first?",
        ),
      )
      expect(composer()).toHaveFocus()
    }
  },
}

/** Every counted row is done: the complete line shows on this load. */
export const GuideAllDone: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(3),
        page: homeHandlers(
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github", "linear"]),
            invitations: ["canceled", "pending"],
            detail: docsWorkspaceDetail,
          }),
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
        page: homeHandlers(adminGuide({}), [quietWorkspace]),
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
          adminGuide({
            github: failed("/api/v1/github/installation"),
            connectors: failed("/api/v1/connectors"),
            detail: docsWorkspaceDetail,
          }),
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
    await waitFor(() => expect(canvas.getByText("Activity")).toBeVisible())
  },
}

const expandedGate = responseGate()
/**
 * While a signal loads, a skeleton holds the place of the expanded card, and
 * the loaded card has the same box.
 */
export const GuideSkeletonMatchesExpanded: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith("/api/v1/connectors"),
            async () => {
              await expandedGate.wait()
              return HttpResponse.json({ items: [] })
            },
          ),
          ...adminGuide({}),
          workspaceListHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expectGuideSkeletonMatches(canvasElement, expandedGate)
  },
}

const collapsedGate = responseGate()
/** After the first question the skeleton has the box of the collapsed card. */
export const GuideSkeletonMatchesCollapsed: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          [
            http.get(
              ({ request }) =>
                new URL(request.url).pathname.endsWith("/api/v1/connectors"),
              async () => {
                await collapsedGate.wait()
                return HttpResponse.json({ items: [] })
              },
            ),
            ...adminGuide({ detail: docsWorkspaceDetail }),
          ],
          [docsWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expectGuideSkeletonMatches(canvasElement, collapsedGate)
  },
}

async function expectGuideSkeletonMatches(
  canvasElement: HTMLElement,
  gate: ReturnType<typeof responseGate>,
) {
  const canvas = within(canvasElement)
  const skeleton = await canvas.findByText("Loading the setup guide")
  const box = (element: Element) => {
    const { width, height } = element.getBoundingClientRect()
    return { width: Math.round(width), height: Math.round(height) }
  }
  const section = skeleton.closest("section")
  if (!section) throw new Error("The skeleton has no section")
  const skeletonBox = box(section)
  expect(skeletonBox.height).toBeGreaterThan(0)
  await gate.release()
  const loaded = await canvas.findByRole("region", { name: "Get started" })
  expect(box(loaded)).toEqual(skeletonBox)
}

/** A failed role query hides the guide. Home still works. */
export const GuideRoleFailureHidesIt: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          [failed("/organization/get-active-member-role")],
          [docsWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText("Activity")).toBeVisible())
    await waitFor(() =>
      expect(canvas.queryByText("Loading the setup guide")).toBeNull(),
    )
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
        page: homeHandlers(adminGuide({}), [quietWorkspace]),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText("Activity")).toBeVisible())
    // An established user gets no skeleton either.
    expect(canvas.queryByText("Loading the setup guide")).toBeNull()
    // Give the guide signals time to settle before the check.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(
      canvas.queryByRole("region", { name: "Get started" }),
    ).not.toBeInTheDocument()
  },
}

/**
 * Onboarding finished long ago, but the organization is new: the guide shows
 * for its first 14 days, also after the first Workspace.
 */
export const GuideEstablishedUserNewOrg: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(30, 2),
        page: homeHandlers(
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github"]),
          }),
          [quietWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    await waitFor(() => expect(guide.getByText("2 of 6 done")).toBeVisible())
  },
}

/**
 * An older organization with no Workspace is still at its start: the guide
 * shows, with the empty activity below it.
 */
export const GuideEstablishedUserEmptyOrg: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(30),
        page: [
          ...adminGuide({}),
          workspaceListHandler([]),
          orgActivityHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    await waitFor(() => expect(guide.getByText("0 of 6 done")).toBeVisible())
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText("Activity")).toBeVisible())
    // The guide stores when it first showed, so it stays after the first
    // Workspace.
    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem("ctxpipe:userPreferences") ?? "{}",
        ).orgGuides?.[`${userId}:acme`]?.startedAt,
      ).toEqual(expect.any(String)),
    )
  },
}

/**
 * An older organization that got its first Workspace from the guide: the
 * guide stays for 14 days from when it first showed.
 */
export const GuideStaysAfterFirstWorkspace: Story = {
  tags: ["workspace-golden"],
  beforeEach: () => {
    window.localStorage.setItem(
      "ctxpipe:userPreferences",
      JSON.stringify({
        orgGuides: {
          [`${userId}:acme`]: {
            startedAt: new Date(Date.now() - DAY_MS).toISOString(),
          },
        },
      }),
    )
    return clearPreferences
  },
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(30),
        page: homeHandlers(
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github"]),
          }),
          [quietWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    await waitFor(() => expect(guide.getByText("2 of 6 done")).toBeVisible())
  },
}
