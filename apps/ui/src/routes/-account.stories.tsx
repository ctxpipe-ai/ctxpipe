import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { sideNavHandlers } from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import preview from "../../.storybook/preview"
import {
  organizationFullWithOrgHandler,
  authConfigHandler,
  organizationListHandler,
  organizationSetActiveHandler,
  sessionSignedInHandler,
  userInvitationsEmptyHandler,
  signedInHandlers,
} from "../mocks/handlers"
import { AccountSettingsBody } from "./[.]auth.account.$accountView"

const meta = preview.meta({
  title: "Pages/User account",
  component: AccountSettingsBody,
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, ...workspaceIngestionHandlers({}))
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/api-keys",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
  args: {
    accountView: "api-keys",
  },
})

/**
 * Body of the user account API keys view, where a user makes personal keys: the
 * user has no keys yet.
 */
export const ApiKeysEmpty = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      http.get("*/.auth/api/v1/auth/api-key/list", () =>
        HttpResponse.json({ apiKeys: [], total: 0 }),
      ),
      http.get("*/api/v1/me/api-keys", () => HttpResponse.json({ keys: [] })),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText(/For your own scripts and agents\./),
      ).toBeVisible(),
    )
    await expect(
      canvas.getByRole("link", { name: "Use an organization key instead." }),
    ).toBeVisible()
    const createButton = canvas.getByRole("button", {
      name: "Create API key",
    })
    await expect(createButton).toBeVisible()
    await expect(
      createButton.closest('[data-slot="card-footer"]'),
    ).not.toBeNull()
  },
})

/**
 * User account page with the app shell, where a user edits the name and email:
 * the user opened Settings from the user menu, so the Account view shows. The
 * index route `/.auth/account/` opens this view.
 */
export const Settings = meta.story({
  tags: ["page"],
  args: { accountView: "settings" },
  beforeEach: ({ msw }) => {
    // The app shell lists the Workspaces of the org. The user has no
    // invitation.
    msw.use(...sideNavHandlers(), userInvitationsEmptyHandler)
  },
  parameters: {
    app: "org",
    review: { kind: "page" },
    route: "/.auth/account/",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "User account" }),
      ).toBeVisible(),
    )
  },
})

/**
 * User account page with the app shell, where a user manages the account: the
 * Organizations view is open, with the shell, the account nav and the view
 * together.
 */
export const OrganizationsView = meta.story({
  tags: ["page"],
  args: { accountView: "organizations" },
  beforeEach: ({ msw }) => {
    // The app shell lists the Workspaces of the org. The user has no
    // invitation.
    msw.use(...sideNavHandlers(), userInvitationsEmptyHandler)
  },
  parameters: {
    app: "org",
    review: { kind: "page" },
    route: "/.auth/account/$accountView",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/organizations",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "User account" }),
      ).toBeVisible(),
    )
  },
})

const connectedApp = {
  id: "ocs_story_agent",
  legacy: false,
  clientId: "client_story_agent",
  clientName: "Example Agent",
  scopes: ["openid", "ctxpipe:read"],
  organizations: [{ id: "org_north", slug: "north-labs", name: "North Labs" }],
  connectedAt: "2026-09-01T10:00:00.000Z",
}

/** A consent from before multi-org grants: one org, revoke only. */
const legacyApp = {
  id: "ocs_story_legacy",
  legacy: true,
  clientId: "client_story_legacy",
  clientName: "Old Agent",
  scopes: ["openid"],
  organizations: [
    { id: "org_harbor", slug: "harbor-systems", name: "Harbor Systems" },
  ],
  connectedAt: "2026-01-01T10:00:00.000Z",
}

const storyOrganizations = [
  { id: "org_north", name: "North Labs", slug: "north-labs" },
  { id: "org_harbor", name: "Harbor Systems", slug: "harbor-systems" },
]

/**
 * A stateful msw backend: PUT and DELETE change the list. `reset` runs
 * before each story render. The handlers replace the default org list, so
 * they go in `session` with the session handlers. `failRevoke` makes
 * DELETE fail with 500.
 */
function connectedAppsHandlers(options: { failRevoke?: boolean } = {}) {
  const initial = () => [connectedApp, legacyApp]
  let apps = initial()
  const requests: { method: string; body?: unknown }[] = []
  return {
    requests,
    reset: () => {
      apps = initial()
      requests.length = 0
    },
    handlers: [
      authConfigHandler,
      sessionSignedInHandler({
        id: "user_storybook",
        onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
      }),
      organizationListHandler(storyOrganizations),
      organizationFullWithOrgHandler,
      http.get("*/api/v1/me/connected-apps", () => HttpResponse.json({ apps })),
      http.put(
        "*/api/v1/me/connected-apps/:id/organizations",
        async ({ request, params }) => {
          const body = (await request.json()) as { organizationIds: string[] }
          requests.push({ method: "PUT", body })
          apps = apps.map((app) =>
            app.id === params.id
              ? {
                  ...app,
                  organizations: storyOrganizations.filter((org) =>
                    body.organizationIds.includes(org.id),
                  ),
                }
              : app,
          )
          return new HttpResponse(null, { status: 204 })
        },
      ),
      http.delete("*/api/v1/me/connected-apps/:id", ({ params }) => {
        requests.push({ method: "DELETE" })
        if (options.failRevoke) {
          // An unhandled server error: a plain text body, no error field.
          return new HttpResponse("Internal Server Error", { status: 500 })
        }
        apps = apps.filter((app) => app.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    ],
  }
}

const editBackend = connectedAppsHandlers()

/**
 * Body of the user account Connected apps view: the user edits the
 * organizations of one app in a dialog, and a legacy app shows a reconnect
 * hint.
 */
export const ConnectedAppsEditOrgs = meta.story({
  tags: ["required"],
  args: { accountView: "connected-apps" },
  beforeEach: ({ msw }) => {
    msw.use(...editBackend.handlers)
    editBackend.reset()
  },
  parameters: {
    intent:
      "Catches a connected app edit that cannot change its organizations, or a legacy app that offers Edit. Legacy apps show a reconnect hint instead. Not for revoke.",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(canvas.getByText("Example Agent")).toBeVisible())
    await expect(canvas.getByText("north-labs")).toBeVisible()
    // The legacy consent offers a reconnect hint in place of Edit.
    await expect(
      canvas.getByText("Reconnect to choose more organizations"),
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Edit organizations of Old Agent" }),
    ).toBeNull()
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Edit organizations of Example Agent",
      }),
    )
    const dialog = within(await body.findByRole("dialog"))
    const north = await dialog.findByRole("checkbox", { name: /North Labs/ })
    const harbor = dialog.getByRole("checkbox", { name: /Harbor Systems/ })
    await expect(north).toBeChecked()
    // At least one org: with none ticked, Save is off.
    await userEvent.click(north)
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled()
    await userEvent.click(harbor)
    await userEvent.click(dialog.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(editBackend.requests).toContainEqual({
        method: "PUT",
        body: { organizationIds: ["org_harbor"] },
      }),
    )
    await waitFor(() => expect(canvas.queryByText("north-labs")).toBeNull())
    await expect(canvas.getAllByText("harbor-systems")).toHaveLength(2)
  },
})

const revokeBackend = connectedAppsHandlers()

/**
 * Connected apps view of the user account, where a user removes the access of
 * OAuth apps: the user revoked one app in its dialog, and the list keeps the
 * other app.
 */
export const ConnectedAppsRevoke = meta.story({
  tags: ["required"],
  args: { accountView: "connected-apps" },
  beforeEach: ({ msw }) => {
    msw.use(...revokeBackend.handlers)
    revokeBackend.reset()
  },
  parameters: {
    intent:
      "Catches a revoke that leaves the app in the list or leaves the dialog open. Confirming sends a DELETE request and removes only that app. Not for revoke errors.",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Revoke Example Agent" }),
    )
    const dialog = within(await body.findByRole("alertdialog"))
    await userEvent.click(dialog.getByRole("button", { name: "Revoke app" }))
    await waitFor(() => expect(canvas.queryByText("Example Agent")).toBeNull())
    await expect(canvas.getByText("Old Agent")).toBeVisible()
    await expect(revokeBackend.requests).toContainEqual({ method: "DELETE" })
    await expect(body.queryByRole("alertdialog")).toBeNull()
  },
})

const failingRevokeBackend = connectedAppsHandlers({ failRevoke: true })

/**
 * Revoke dialog of the Connected apps view: the user pressed Revoke app and the
 * server had an error, so the dialog stays open with the cause and a retry.
 */
export const ConnectedAppsRevokeError = meta.story({
  tags: ["required"],
  args: { accountView: "connected-apps" },
  beforeEach: ({ msw }) => {
    msw.use(...failingRevokeBackend.handlers)
    failingRevokeBackend.reset()
  },
  parameters: {
    intent:
      "Catches a failed revoke that closes the dialog or removes the app. The dialog stays open with the error and the app stays listed. Not for a successful revoke.",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Revoke Example Agent" }),
    )
    const dialog = within(await body.findByRole("alertdialog"))
    const revoke = dialog.getByRole("button", { name: "Revoke app" })
    await userEvent.click(revoke)
    // The dialog stays open and shows the error.
    await waitFor(() =>
      expect(
        dialog.getByText("The server had an error. Try again."),
      ).toBeVisible(),
    )
    await expect(body.getByRole("alertdialog")).toBeVisible()
    await expect(canvas.getByText("Example Agent")).toBeVisible()
    // End with the pointer off the button, so its color is the idle one.
    await userEvent.unhover(revoke)
  },
})

/**
 * Body of the user account Connected apps view, which lists the apps with
 * access: the user has no connected apps.
 */
export const ConnectedAppsEmpty = meta.story({
  args: { accountView: "connected-apps" },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get("*/api/v1/me/connected-apps", () =>
        HttpResponse.json({ apps: [] }),
      ),
    )
  },
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("No connected apps")).toBeVisible(),
    )
    await expect(
      canvas.getByRole("link", { name: "Connected apps" }),
    ).toBeVisible()
  },
})

type StoryKey = {
  id: string
  name: string
  start: string
  expiresAt: string
  organizationIds: string[] | null
}

/**
 * A stateful msw backend for personal keys: create and PUT change the list.
 * Create records the org set header that the backend writes before it
 * answers. `reset` runs before each story render.
 */
function personalKeysHandlers() {
  const initial = (): StoryKey[] => [
    {
      id: "key_agent",
      name: "local-agent",
      start: "ctx_ag",
      expiresAt: "2026-12-01T00:00:00.000Z",
      organizationIds: ["org_north"],
    },
    {
      id: "key_old",
      name: "old-script",
      start: "ctx_ol",
      expiresAt: "2026-12-01T00:00:00.000Z",
      organizationIds: null,
    },
  ]
  let keys = initial()
  const requests: { kind: "create" | "put"; organizations: unknown }[] = []
  return {
    requests,
    reset: () => {
      keys = initial()
      requests.length = 0
    },
    handlers: [
      authConfigHandler,
      sessionSignedInHandler({
        id: "user_storybook",
        onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
      }),
      organizationListHandler(storyOrganizations),
      organizationFullWithOrgHandler,
      http.get("*/.auth/api/v1/auth/api-key/list", () =>
        HttpResponse.json({ apiKeys: keys, total: keys.length }),
      ),
      http.post("*/.auth/api/v1/auth/api-key/create", async ({ request }) => {
        const body = (await request.json()) as { name: string }
        const header = request.headers.get("x-ctxpipe-api-key-organizations")
        requests.push({ kind: "create", organizations: header })
        keys = [
          ...keys,
          {
            id: "key_new",
            name: body.name,
            start: "ctx_nw",
            expiresAt: "2026-12-01T00:00:00.000Z",
            organizationIds: header ? header.split(",") : null,
          },
        ]
        return HttpResponse.json({
          id: "key_new",
          name: body.name,
          key: "ctx_personal_plaintext_shown_once",
          configId: "default",
        })
      }),
      http.get("*/api/v1/me/api-keys", () =>
        HttpResponse.json({
          keys: keys.map((key) => ({
            id: key.id,
            organizations:
              key.organizationIds === null
                ? null
                : storyOrganizations.filter((org) =>
                    key.organizationIds?.includes(org.id),
                  ),
          })),
        }),
      ),
      http.put(
        "*/api/v1/me/api-keys/:id/organizations",
        async ({ request, params }) => {
          const body = (await request.json()) as { organizationIds: string[] }
          requests.push({ kind: "put", organizations: body.organizationIds })
          keys = keys.map((key) =>
            key.id === params.id
              ? { ...key, organizationIds: body.organizationIds }
              : key,
          )
          return new HttpResponse(null, { status: 204 })
        },
      ),
    ],
  }
}

const createKeyBackend = personalKeysHandlers()

/**
 * Body of the user account API keys view: the user creates a personal key in a
 * dialog, picks one organization, and sees the new key one time. The play
 * proves that Create stays off until the user picks at least one organization.
 */
export const ApiKeysCreateWithOrganizations = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...createKeyBackend.handlers)
    createKeyBackend.reset()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(canvas.getByText("local-agent")).toBeVisible())
    await userEvent.click(
      canvas.getByRole("button", { name: "Create API key" }),
    )
    const dialog = within(await body.findByRole("dialog"))
    await userEvent.type(dialog.getByLabelText("Name"), "ci-agent")
    await dialog.findByRole("checkbox", { name: /North Labs/ })
    // With no organization, Create is off.
    await waitFor(() =>
      expect(
        dialog.getByRole("button", { name: "Create API key" }),
      ).toBeDisabled(),
    )
    await userEvent.click(
      dialog.getByRole("checkbox", { name: /Harbor Systems/ }),
    )
    await waitFor(() =>
      expect(
        dialog.getByRole("button", { name: "Create API key" }),
      ).toBeEnabled(),
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Create API key" }),
    )
    await waitFor(() =>
      expect(body.getByText("ctx_personal_plaintext_shown_once")).toBeVisible(),
    )
    await expect(createKeyBackend.requests).toEqual([
      { kind: "create", organizations: "org_harbor" },
    ])
    // The list shows the set of the new key.
    await waitFor(() =>
      expect(canvas.getByText("ci-agent")).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(canvas.getByText("harbor-systems")).toBeInTheDocument(),
    )
  },
})

const editKeyBackend = personalKeysHandlers()

/**
 * Body of the user account API keys view: the user changes the organizations of
 * a key in a dialog. The list shows the organizations of each key, and a key
 * from before organization sets reaches all organizations.
 */
export const ApiKeysEditOrganizations = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...editKeyBackend.handlers)
    editKeyBackend.reset()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(canvas.getByText("north-labs")).toBeVisible())
    await expect(canvas.getByText("All your organizations")).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Edit organizations of local-agent",
      }),
    )
    const dialog = within(await body.findByRole("dialog"))
    await waitFor(() =>
      expect(
        dialog.getByRole("checkbox", { name: /North Labs/ }),
      ).toBeChecked(),
    )
    // At least one org: with none ticked, Save is off.
    await userEvent.click(dialog.getByRole("checkbox", { name: /North Labs/ }))
    await waitFor(() =>
      expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled(),
    )
    await userEvent.click(
      dialog.getByRole("checkbox", { name: /Harbor Systems/ }),
    )
    await userEvent.click(dialog.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(editKeyBackend.requests).toContainEqual({
        kind: "put",
        organizations: ["org_harbor"],
      }),
    )
    await waitFor(() => expect(canvas.queryByText("north-labs")).toBeNull())
    await expect(canvas.getByText("harbor-systems")).toBeVisible()
  },
})

/**
 * The user deleted an organization, and the stored selection still names it.
 * The Workspace list of that organization answers 404, as the backend does.
 * `requested` records every Workspace list request by organization slug.
 */
function deletedOrganizationBackend(
  organizations: { id: string; name: string; slug: string }[],
) {
  const requested: string[] = []
  return {
    requested,
    reset: () => {
      requested.length = 0
      window.localStorage.setItem(
        "ctxpipe:userPreferences",
        JSON.stringify({ selectedOrganizationSlug: "deleted-org" }),
      )
    },
    handlers: [
      authConfigHandler,
      sessionSignedInHandler({
        id: "user_storybook",
        onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
      }),
      organizationListHandler(organizations),
      organizationFullWithOrgHandler,
    ],
    page: [
      http.get("*/:orgSlug/api/v1/workspaces", ({ params }) => {
        requested.push(String(params.orgSlug))
        if (params.orgSlug === "deleted-org") {
          return HttpResponse.json({ error: "Not found" }, { status: 404 })
        }
        return HttpResponse.json({ items: [], lastUsedWorkspaceId: null })
      }),
      userInvitationsEmptyHandler,
      // The shell makes the first org active in place of the deleted one.
      organizationSetActiveHandler(),
    ],
  }
}

const staleSelectionBackend = deletedOrganizationBackend([
  { id: "org_other", name: "Other Org", slug: "other-org" },
])

/**
 * Organizations view of the user account, with the app shell, after the
 * organization delete dialog: the stored organization was deleted, so the shell
 * opens the first other organization. The page does not show the error screen.
 */
export const OrganizationDeletedStaleSelection = meta.story({
  tags: ["required"],
  args: { accountView: "organizations" },
  beforeEach: ({ msw }) => {
    msw.use(...staleSelectionBackend.handlers, ...staleSelectionBackend.page)
    staleSelectionBackend.reset()
  },
  parameters: {
    app: "org",
    review: { kind: "page" },
    intent:
      "Catches a deleted organization that stays selected in the shell. The shell must switch to the first remaining organization and stop requesting the deleted one. Not for the last organization.",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/organizations",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "User account" }),
      ).toBeVisible(),
    )
    // The first organization replaces the stale one in the shell.
    await waitFor(() =>
      expect(staleSelectionBackend.requested).toContain("other-org"),
    )
    await waitFor(() => expect(canvas.getByText("Workspaces")).toBeVisible())
    await waitFor(() => {
      expect(staleSelectionBackend.requested).not.toContain("deleted-org")
      expect(canvas.queryByText("Something went wrong")).toBeNull()
    })
  },
})

const lastOrganizationBackend = deletedOrganizationBackend([])

/**
 * Redirect after the user deletes the last organization: the app sends the user
 * to onboarding, which this story shows as a plain route marker. The play
 * proves that the app does not request the deleted organization.
 */
export const LastOrganizationDeleted = meta.story({
  tags: ["required"],
  args: { accountView: "organizations" },
  beforeEach: ({ msw }) => {
    msw.use(
      ...lastOrganizationBackend.handlers,
      ...lastOrganizationBackend.page,
    )
    lastOrganizationBackend.reset()
  },
  parameters: {
    app: "org",
    visual: {
      skip: "Behavior test: it ends on a story route marker, which the product does not render.",
    },
    intent:
      "Catches a delete of the last organization that shows an error screen or requests the deleted one. The user goes to onboarding. Not for other organizations.",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/organizations",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Story route: onboarding")).toBeVisible(),
    )
    await waitFor(() => {
      expect(lastOrganizationBackend.requested).not.toContain("deleted-org")
      expect(canvas.queryByText("Something went wrong")).toBeNull()
    })
  },
})
