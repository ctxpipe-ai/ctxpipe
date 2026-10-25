import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  entryPageInnerDecorators,
  orgPageDecorators,
} from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import {
  authConfigHandler,
  organizationListHandler,
  sessionSignedInHandler,
} from "../mocks/handlers"
import { AccountSettingsBody } from "./[.]auth.account.$accountView"

const meta = {
  title: "Pages/User account",
  component: AccountSettingsBody,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/api-keys",
    } satisfies StoryRouteParams,
  },
  args: {
    accountView: "api-keys",
  },
} satisfies Meta<typeof AccountSettingsBody>

export default meta

type Story = StoryObj<typeof meta>

export const ApiKeysEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/api-key/list", () =>
            HttpResponse.json({ apiKeys: [], total: 0 }),
          ),
        ],
      },
    },
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
}

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
    { id: "org_south", slug: "south-works", name: "South Works" },
  ],
  connectedAt: "2026-01-01T10:00:00.000Z",
}

const storyOrganizations = [
  { id: "org_north", name: "North Labs", slug: "north-labs" },
  { id: "org_south", name: "South Works", slug: "south-works" },
]

/**
 * A stateful msw backend: PUT and DELETE change the list. `reset` runs
 * before each story render. The handlers replace the default org list, so
 * they go in `defaults` with the session handlers. `failRevoke` makes
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
          return HttpResponse.json(
            { error: "The server could not revoke the app" },
            { status: 500 },
          )
        }
        apps = apps.filter((app) => app.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    ],
  }
}

const editBackend = connectedAppsHandlers()

export const ConnectedAppsEditOrgs: Story = {
  tags: ["workspace-golden"],
  args: { accountView: "connected-apps" },
  beforeEach: editBackend.reset,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
    msw: { handlers: { defaults: editBackend.handlers } },
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
    const south = dialog.getByRole("checkbox", { name: /South Works/ })
    await expect(north).toBeChecked()
    // At least one org: with none ticked, Save is off.
    await userEvent.click(north)
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled()
    await userEvent.click(south)
    await userEvent.click(dialog.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(editBackend.requests).toContainEqual({
        method: "PUT",
        body: { organizationIds: ["org_south"] },
      }),
    )
    await waitFor(() => expect(canvas.queryByText("north-labs")).toBeNull())
    await expect(canvas.getAllByText("south-works")).toHaveLength(2)
  },
}

const revokeBackend = connectedAppsHandlers()

export const ConnectedAppsRevoke: Story = {
  tags: ["workspace-golden"],
  args: { accountView: "connected-apps" },
  beforeEach: revokeBackend.reset,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
    msw: { handlers: { defaults: revokeBackend.handlers } },
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
}

const failingRevokeBackend = connectedAppsHandlers({ failRevoke: true })

export const ConnectedAppsRevokeError: Story = {
  tags: ["workspace-golden"],
  args: { accountView: "connected-apps" },
  beforeEach: failingRevokeBackend.reset,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
    msw: { handlers: { defaults: failingRevokeBackend.handlers } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Revoke Example Agent" }),
    )
    const dialog = within(await body.findByRole("alertdialog"))
    await userEvent.click(dialog.getByRole("button", { name: "Revoke app" }))
    // The dialog stays open and shows the error.
    await waitFor(() =>
      expect(
        dialog.getByText("The server could not revoke the app"),
      ).toBeVisible(),
    )
    await expect(body.getByRole("alertdialog")).toBeVisible()
    await expect(canvas.getByText("Example Agent")).toBeVisible()
  },
}

export const ConnectedAppsEmpty: Story = {
  args: { accountView: "connected-apps" },
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/connected-apps",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get("*/api/v1/me/connected-apps", () =>
            HttpResponse.json({ apps: [] }),
          ),
        ],
      },
    },
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
}

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

/** A new personal key needs at least one organization before Create. */
export const ApiKeysCreateWithOrganizations: Story = {
  beforeEach: createKeyBackend.reset,
  parameters: {
    msw: { handlers: { defaults: createKeyBackend.handlers } },
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
    await userEvent.click(dialog.getByRole("checkbox", { name: /South Works/ }))
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
      { kind: "create", organizations: "org_south" },
    ])
    // The list shows the set of the new key.
    await waitFor(() =>
      expect(canvas.getByText("ci-agent")).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(canvas.getByText("south-works")).toBeInTheDocument(),
    )
  },
}

const editKeyBackend = personalKeysHandlers()

/** The key list shows each set; a key from before sets reaches every org. */
export const ApiKeysEditOrganizations: Story = {
  beforeEach: editKeyBackend.reset,
  parameters: {
    msw: { handlers: { defaults: editKeyBackend.handlers } },
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
    await userEvent.click(dialog.getByRole("checkbox", { name: /South Works/ }))
    await userEvent.click(dialog.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(editKeyBackend.requests).toContainEqual({
        kind: "put",
        organizations: ["org_south"],
      }),
    )
    await waitFor(() => expect(canvas.queryByText("north-labs")).toBeNull())
    await expect(canvas.getByText("south-works")).toBeVisible()
  },
}

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
    ],
    page: [
      http.get("*/:orgSlug/api/v1/workspaces", ({ params }) => {
        requested.push(String(params.orgSlug))
        if (params.orgSlug === "deleted-org") {
          return HttpResponse.json({ error: "Not found" }, { status: 404 })
        }
        return HttpResponse.json({ items: [], lastUsedWorkspaceId: null })
      }),
    ],
  }
}

const staleSelectionBackend = deletedOrganizationBackend([
  { id: "org_other", name: "Other Org", slug: "other-org" },
])

/**
 * The page that the organization delete dialog opens. The stored selection
 * is an organization that no longer exists. The shell falls back to the
 * first organization, and the page does not show the error screen.
 */
export const OrganizationDeletedStaleSelection: Story = {
  tags: ["workspace-golden"],
  args: { accountView: "organizations" },
  decorators: orgPageDecorators,
  beforeEach: staleSelectionBackend.reset,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/organizations",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        defaults: staleSelectionBackend.handlers,
        page: staleSelectionBackend.page,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "user account" }),
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
}

const lastOrganizationBackend = deletedOrganizationBackend([])

/** The last organization is deleted: the user lands on onboarding. */
export const LastOrganizationDeleted: Story = {
  tags: ["workspace-golden"],
  args: { accountView: "organizations" },
  decorators: orgPageDecorators,
  beforeEach: lastOrganizationBackend.reset,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/organizations",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        defaults: lastOrganizationBackend.handlers,
        page: lastOrganizationBackend.page,
      },
    },
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
}
