import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
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
