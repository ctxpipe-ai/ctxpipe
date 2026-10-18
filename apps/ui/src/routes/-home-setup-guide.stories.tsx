import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http, type RequestHandler } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { responseGate } from "@/components/ui/skeletonMatchStory"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import type { Workspace, WorkspaceDetail } from "@/features/workspaces/types"
import {
  createdWorkspace,
  createdWritableWorkspaceDetail,
  docsWorkspace,
  docsWorkspaceDetail,
  emptyLinkedWorkspaceDetail,
  failedHydrateWorkspace,
  hydratingWorkspace,
  readOnlyWorkspaceDetail,
  waitingForTipWorkspace,
} from "@/features/workspaces/workspace-fixtures"
import {
  authConfigHandler,
  githubInstallationLinkedHandler,
  githubInstallationNoneHandler,
  organizationListHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import {
  githubInstallationReposHandler,
  orgActivityHandler,
  workspaceDetailHandler,
  workspaceListHandler,
  workspaceShellHandlers,
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
import { OrgHomePageContent } from "./$orgSlug.index"

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString()
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

/** An old Workspace with no conversation of this user yet. */
const quietWorkspace: Workspace = {
  ...docsWorkspace,
  createdAt: new Date(Date.now() - 365 * DAY_MS).toISOString(),
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
    expect(guide.getByText("· step 2 of 2")).toBeVisible()
    expect(
      guide.getByText(
        "Loading the files. You can ask questions while it builds.",
      ),
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

const waitingWorkspace: Workspace = {
  ...waitingForTipWorkspace,
  mostRecentConversationId: null,
}
/** The first Workspace waits for the first commit: build step 1 of 2. */
export const GuideAdminWorkspaceReadingRepository: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github"]),
            detail: { ...emptyLinkedWorkspaceDetail, ...waitingWorkspace },
          }),
          [waitingWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText("2 of 6 done")).toBeVisible()
    expect(guide.getByText("· step 1 of 2")).toBeVisible()
    expect(guide.getByText("Reading the Workspace repository.")).toBeVisible()
  },
}

const failedWorkspace: Workspace = {
  ...failedHydrateWorkspace,
  mostRecentConversationId: null,
}
/** The build of the first Workspace failed: the row says so and links to it. */
export const GuideAdminWorkspaceBuildFailed: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers(
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github"]),
            detail: { ...emptyLinkedWorkspaceDetail, ...failedWorkspace },
          }),
          [failedWorkspace],
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    expect(guide.getByText("2 of 6 done")).toBeVisible()
    expect(guide.getByText("Build failed")).toBeVisible()
    expect(guide.getByRole("button", { name: "See the error" })).toBeVisible()
    expect(guide.queryByText("Building")).not.toBeInTheDocument()
  },
}

const createState = { created: false }
const workspacesPath = ({ request }: { request: Request }) =>
  /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname)
/**
 * Step 2 of the guide: Create Workspace opens Add Workspace on Home. After
 * "Done", the guide shows the build of the new Workspace.
 */
export const GuideAdminCreatesWorkspaceOnHome: Story = {
  tags: ["workspace-golden"],
  beforeEach: () => {
    createState.created = false
  },
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: [
          http.get(workspacesPath, () =>
            HttpResponse.json({
              items: createState.created ? [createdWorkspace] : [],
              lastUsedWorkspaceId: createState.created
                ? createdWorkspace.id
                : null,
            }),
          ),
          http.post(workspacesPath, () => {
            createState.created = true
            return HttpResponse.json(createdWorkspace, { status: 201 })
          }),
          ...adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: orgConnectionsHandler([
              { id: "con_gh", type: "github", displayName: "acme" },
            ]),
            detail: createdWritableWorkspaceDetail,
          }),
          githubInstallationReposHandler(),
          workspaceSourcesHandler(workspaceSourceList()),
          // Without this, the read goes to the network and fails at a random time.
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
          orgActivityHandler(),
          ...workspaceShellHandlers({
            workspaces: [createdWorkspace],
            detail: createdWritableWorkspaceDetail,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    await waitFor(() => expect(guide.getByText("1 of 6 done")).toBeVisible())
    await userEvent.click(
      guide.getByRole("button", { name: "Create Workspace" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    const dialog = within(
      await body.findByRole("dialog", { name: "Add Workspace" }),
    )
    await userEvent.click(
      await dialog.findByRole("radio", { name: /acme\/handbook/ }),
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Create Workspace" }),
    )
    // Step 2 has settled when its sources show. Before that, the card above
    // Done still changes height, and a click can land on a button that moves.
    await dialog.findByRole("button", { name: "Add repositories" })
    await userEvent.click(dialog.getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(
        body.queryByRole("dialog", { name: "Add Workspace" }),
      ).not.toBeInTheDocument(),
    )
    // Home stays, and the guide shows the build of the new Workspace.
    const after = await findGuide(canvasElement)
    await waitFor(() => expect(after.getByText("2 of 6 done")).toBeVisible())
    await waitFor(() =>
      expect(
        after.getByText("Reading the Workspace repository."),
      ).toBeVisible(),
    )
  },
}

const linkState = { opened: false }
const sourcesPath = ({ request }: { request: Request }) =>
  /\/api\/v1\/workspaces\/[^/]+\/sources$/.test(new URL(request.url).pathname)
/**
 * "Link repositories" opens Add repositories on Home, with focus in the
 * dialog. After the pull request, the row shows "Awaiting merge" (CTX-864).
 */
export const GuideAdminLinksRepositoriesOnHome: Story = {
  beforeEach: () => {
    linkState.opened = false
  },
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: [
          ...adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: orgConnectionsHandler([
              { id: "con_gh", type: "github", displayName: "acme" },
            ]),
            detail: emptyLinkedWorkspaceDetail,
          }),
          http.get(sourcesPath, () =>
            HttpResponse.json(
              workspaceSourceList(
                linkState.opened
                  ? {
                      pendingChanges: [
                        {
                          path: "sources/github/acme/api.md",
                          provider: "github",
                          action: "add",
                          pullRequestUrl: "https://github.com/acme/docs/pull/9",
                          createdAt: "2026-10-18T00:00:00.000Z",
                        },
                      ],
                    }
                  : {},
              ),
            ),
          ),
          http.post(sourcesPath, () => {
            linkState.opened = true
            return HttpResponse.json({
              outcome: "pull_request",
              path: "sources/github/acme/api.md",
              pullRequestUrl: "https://github.com/acme/docs/pull/9",
            })
          }),
          githubInstallationReposHandler([
            {
              name: "api",
              clone_url: "https://github.com/acme/api.git",
              full_name: "acme/api",
            },
          ]),
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
          orgActivityHandler(),
          ...workspaceShellHandlers({
            workspaces: [quietWorkspace],
            detail: emptyLinkedWorkspaceDetail,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    await waitFor(() => expect(guide.getByText("2 of 6 done")).toBeVisible())
    await userEvent.click(
      guide.getByRole("button", { name: "Link repositories" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("dialog", { name: "Add repositories" })
    // Focus goes into the dialog, not to the composer.
    await waitFor(() =>
      expect(dialog.contains(canvasElement.ownerDocument.activeElement)).toBe(
        true,
      ),
    )
    await userEvent.click(
      await within(dialog).findByRole("checkbox", { name: "acme/api" }),
    )
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() =>
      expect(
        body.queryByRole("dialog", { name: "Add repositories" }),
      ).not.toBeInTheDocument(),
    )
    // Home stays, and the row shows the pull request that waits.
    const after = await findGuide(canvasElement)
    await waitFor(() =>
      expect(
        after.getByRole("link", { name: /^Awaiting merge/ }),
      ).toHaveAttribute("href", "https://github.com/acme/docs/pull/9"),
    )
    await expect(after.getByText("2 of 6 done")).toBeVisible()
  },
}

/**
 * The handlers of a Home guide whose Workspace cannot take repositories. The
 * list of GitHub repositories answers too, so a missing gate would show it.
 */
function repositoriesGateHandlers(input: {
  detail: WorkspaceDetail
  canEdit: boolean
  formatVersion: number
  /** False: the org has no GitHub connection. */
  connected?: boolean
}) {
  return [
    ...adminGuide({
      github: githubInstallationLinkedHandler,
      connectors: orgConnectionsHandler(
        input.connected === false
          ? []
          : [{ id: "con_gh", type: "github", displayName: "acme" }],
      ),
      detail: input.detail,
    }),
    http.get(sourcesPath, () =>
      HttpResponse.json(workspaceSourceList({ canEdit: input.canEdit })),
    ),
    workspaceUpgradesHandler(
      upgradesFixture([], { formatVersion: input.formatVersion }),
    ),
    githubInstallationReposHandler([
      {
        name: "api",
        clone_url: "https://github.com/acme/api.git",
        full_name: "acme/api",
      },
    ]),
    orgActivityHandler(),
    ...workspaceShellHandlers({
      workspaces: [quietWorkspace],
      detail: input.detail,
    }),
  ]
}

async function openLinkRepositories(canvasElement: HTMLElement) {
  const guide = await findGuide(canvasElement)
  await waitFor(() => expect(guide.getByText("2 of 6 done")).toBeVisible())
  await userEvent.click(
    guide.getByRole("button", { name: "Link repositories" }),
  )
  return within(
    await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Add repositories",
    }),
  )
}

/**
 * A read-only Workspace: the dialog gives the reason and the next step, and
 * it offers no list and no pull request (CTX-865).
 */
export const GuideRepositoriesReadOnlyShowsReason: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: repositoriesGateHandlers({
          detail: readOnlyWorkspaceDetail,
          canEdit: false,
          formatVersion: 3,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openLinkRepositories(canvasElement)
    await dialog.findByText("The GitHub App cannot write to this repository.")
    await dialog.findByRole("button", { name: "Open Workspace settings" })
    await waitFor(() =>
      expect(
        dialog.queryByRole("checkbox", { name: "acme/api" }),
      ).not.toBeInTheDocument(),
    )
    await expect(
      dialog.queryByRole("button", { name: "Open a pull request" }),
    ).not.toBeInTheDocument()
  },
}

/**
 * A Workspace below format 2: the dialog says to upgrade first and offers the
 * way to the upgrades, as Add Workspace step 2 does (CTX-865).
 */
export const GuideRepositoriesNeedUpgradeFirst: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: repositoriesGateHandlers({
          detail: emptyLinkedWorkspaceDetail,
          canEdit: true,
          formatVersion: 1,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openLinkRepositories(canvasElement)
    await dialog.findByText(
      "Upgrade this Workspace before you add repositories",
    )
    await dialog.findByRole("button", { name: "Review upgrades" })
    await waitFor(() =>
      expect(
        dialog.queryByRole("checkbox", { name: "acme/api" }),
      ).not.toBeInTheDocument(),
    )
    await expect(
      dialog.queryByRole("button", { name: "Open a pull request" }),
    ).not.toBeInTheDocument()
  },
}

/** No GitHub connection yet: the dialog links to the Connectors page. */
export const GuideRepositoriesWithoutConnectionLinksToConnectors: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: repositoriesGateHandlers({
          detail: emptyLinkedWorkspaceDetail,
          canEdit: true,
          formatVersion: 3,
          connected: false,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openLinkRepositories(canvasElement)
    await dialog.findByRole("link", {
      name: "Connect GitHub on the Connectors page first.",
    })
    await waitFor(() =>
      expect(
        dialog.getByRole("link", {
          name: "Connect GitHub on the Connectors page first.",
        }),
      ).toHaveAttribute("href", "/acme/connectors"),
    )
  },
}

let connectionReads = 0

/** The connections load fails: the dialog shows Retry, not "connect first". */
export const GuideRepositoriesConnectionsFailedShowsRetry: Story = {
  beforeEach: () => {
    connectionReads = 0
  },
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: [
          // The guide reads the list first and gets no connection. The
          // dialog reads it again and the read fails.
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith("/api/v1/connectors"),
            () => {
              connectionReads += 1
              return connectionReads === 1
                ? HttpResponse.json({ items: [] })
                : HttpResponse.json({ error: "failed" }, { status: 500 })
            },
          ),
          ...repositoriesGateHandlers({
            detail: emptyLinkedWorkspaceDetail,
            canEdit: true,
            formatVersion: 3,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openLinkRepositories(canvasElement)
    await dialog.findByText("Could not load the Workspace")
    await dialog.findByRole("button", { name: "Retry" })
    await expect(
      dialog.queryByText("Connect GitHub on the Connectors page first."),
    ).not.toBeInTheDocument()
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
  },
}

/**
 * An older organization whose first Workspace is from the last 14 days: the
 * guide stays, so it does not go away in the middle of the setup.
 */
export const GuideStaysAfterFirstWorkspace: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(30),
        page: homeHandlers(
          adminGuide({
            github: githubInstallationLinkedHandler,
            connectors: connectorsHandler(["github"]),
          }),
          [{ ...quietWorkspace, createdAt: daysAgo(1) }],
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
 * A member in an org with no Workspace: only an owner or admin can pick the
 * repository, so the row asks for an admin and has no Create button.
 */
export const GuideMemberNoWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        defaults: sessionDefaults(1),
        page: homeHandlers([roleHandler("member")], []),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const guide = await findGuide(canvasElement)
    await waitFor(() =>
      expect(guide.getByText("Create your first Workspace")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        guide.getByText("Ask an admin to create a Workspace."),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        guide.queryByRole("button", { name: "Create Workspace" }),
      ).not.toBeInTheDocument(),
    )
  },
}
