import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { authConfigHandler, organizationListHandler } from "../mocks/handlers"
import { ConsentPage } from "./[.]auth.consent"

/** The headers of each consent request that the page sends. */
const consentRequests: { organizations: string | null; body: unknown }[] = []

const meta = {
  title: "Pages/OAuth consent",
  component: ConsentPage,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/consent",
      search: "?client_id=client_story&scope=ctxpipe%3Aread",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          http.get("*/.auth/api/v1/auth/get-session", () =>
            HttpResponse.json({
              session: {
                id: "storybook-session",
                userId: "user_storybook",
                activeOrganizationId: "org_north",
                expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              },
              user: {
                id: "user_storybook",
                email: "story@ctxpipe.local",
                name: "Storybook User",
                emailVerified: true,
                onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
              },
            }),
          ),
          organizationListHandler([
            { id: "org_north", name: "North Labs", slug: "north-labs" },
            { id: "org_south", name: "South Works", slug: "south-works" },
          ]),
          http.post("*/oauth2/consent", async ({ request }) => {
            consentRequests.push({
              organizations: request.headers.get(
                "x-ctxpipe-oauth-organization",
              ),
              body: await request.json(),
            })
            // No redirect: the page must stay for the assertions.
            return HttpResponse.json({})
          }),
        ],
      },
    },
  },
} satisfies Meta<typeof ConsentPage>

export default meta

type Story = StoryObj<typeof meta>

export const ConsentSendsTickedOrgs: Story = {
  tags: ["workspace-golden"],
  beforeEach: () => {
    consentRequests.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const north = await canvas.findByRole("checkbox", { name: /North Labs/ })
    await expect(north).toBeChecked()
    await userEvent.click(canvas.getByRole("checkbox", { name: /South Works/ }))
    await userEvent.click(canvas.getByRole("button", { name: "Allow" }))
    await waitFor(() => expect(consentRequests).toHaveLength(1))
    await expect(consentRequests[0]?.organizations).toBe("org_north,org_south")
    await expect(consentRequests[0]?.body).toMatchObject({
      accept: true,
      scope: "ctxpipe:read",
    })
  },
}
