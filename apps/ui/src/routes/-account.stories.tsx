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
    await expect(
      await canvas.findByText(/For your own scripts and agents\./),
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Use an organisation key instead." }),
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
  grantId: "ogr_story_agent",
  clientId: "client_story_agent",
  clientName: "Example Agent",
  scopes: ["openid", "ctxpipe:read"],
  organizations: [{ id: "org_north", slug: "north-labs", name: "North Labs" }],
  connectedAt: "2026-09-01T10:00:00.000Z",
}

const storyOrganizations = [
  { id: "org_north", name: "North Labs", slug: "north-labs" },
  { id: "org_south", name: "South Works", slug: "south-works" },
]

/**
 * A stateful msw backend for one grant: PUT and DELETE change the list.
 * `reset` runs before each story render. The handlers replace the default
 * org list, so they go in `defaults` with the session handlers.
 */
function connectedAppsHandlers() {
  let apps = [connectedApp]
  const requests: { method: string; body?: unknown }[] = []
  return {
    requests,
    reset: () => {
      apps = [connectedApp]
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
        "*/api/v1/me/connected-apps/:grantId/organizations",
        async ({ request, params }) => {
          const body = (await request.json()) as { organizationIds: string[] }
          requests.push({ method: "PUT", body })
          apps = apps.map((app) =>
            app.grantId === params.grantId
              ? {
                  ...app,
                  organizations: storyOrganizations.filter((org) =>
                    body.organizationIds.includes(org.id),
                  ),
                }
              : app,
          )
          const updated = apps.find((app) => app.grantId === params.grantId)
          return HttpResponse.json(updated)
        },
      ),
      http.delete("*/api/v1/me/connected-apps/:grantId", ({ params }) => {
        requests.push({ method: "DELETE" })
        apps = apps.filter((app) => app.grantId !== params.grantId)
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
    await expect(await canvas.findByText("Example Agent")).toBeVisible()
    await expect(canvas.getByText("north-labs")).toBeVisible()
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
    await expect(await canvas.findByText("south-works")).toBeVisible()
    await expect(canvas.queryByText("north-labs")).toBeNull()
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
    await expect(await canvas.findByText("No connected apps")).toBeVisible()
    await expect(revokeBackend.requests).toContainEqual({ method: "DELETE" })
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
    await expect(await canvas.findByText("No connected apps")).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Connected apps" }),
    ).toBeVisible()
  },
}
