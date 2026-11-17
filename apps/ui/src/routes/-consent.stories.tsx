import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import {
  organizationFullWithOrgHandler,
  authConfigHandler,
  organizationListHandler,
} from "../mocks/handlers"
import { ConsentPage } from "./[.]auth.consent"

/** The headers of each consent request that the page sends. */
const consentRequests: { organizations: string | null; body: unknown }[] = []

const meta = {
  title: "Pages/OAuth consent",
  tags: ["page"],
  component: ConsentPage,
  parameters: {
    app: "root",
    layout: "fullscreen",
    route: "/.auth/consent",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/consent",
      search: "?client_id=client_story&scope=ctxpipe%3Aread",
    } satisfies StoryRouteParams,
    review: { kind: "page" },
    msw: {
      handlers: {
        session: [
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
            {
              id: "org_harbor",
              name: "Harbor Systems",
              slug: "harbor-systems",
            },
          ]),
          organizationFullWithOrgHandler,
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
  parameters: {
    review: {
      purpose:
        "OAuth consent screen, where a user lets an app read ctxpipe for some organizations: the user ticks a second organization and allows.",
    },
    intent:
      "Catches a consent route that sends the wrong organizations or scope. The consent request carries the ticked organizations and the read scope. Not for the consent screen layout.",
  },
  tags: ["required"],
  beforeEach: () => {
    consentRequests.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const north = await canvas.findByRole("checkbox", { name: /North Labs/ })
    await expect(north).toBeChecked()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /Harbor Systems/ }),
    )
    await userEvent.click(canvas.getByRole("button", { name: "Allow" }))
    await waitFor(() => expect(consentRequests).toHaveLength(1))
    await expect(consentRequests[0]?.organizations).toBe("org_north,org_harbor")
    await expect(consentRequests[0]?.body).toMatchObject({
      accept: true,
      scope: "ctxpipe:read",
    })
  },
}
