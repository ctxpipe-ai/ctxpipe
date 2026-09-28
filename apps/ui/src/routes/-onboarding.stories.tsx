import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  authConfigHandler,
  githubInstallationNoneHandler,
  organizationListEmptyHandler,
  organizationListWithOrgHandler,
  sessionSignedInOnboardingHandler,
  userOnboardingHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OnboardingPageContent } from "./onboarding"

const noRepositoriesHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith("/api/v1/repositories"),
  () => HttpResponse.json({ items: [] }),
)

const meta = {
  title: "Pages/Onboarding",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/onboarding",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/** New admin, no organisation yet. Typing the name fills the slug and the frame label. */
export const AdminCreateOrganisation: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    msw: {
      handlers: {
        // `defaults` replaces the preview's onboarded user and `acme` org.
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListEmptyHandler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = await canvas.findByRole("textbox", {
      name: /organisation name/i,
    })
    await userEvent.type(name, "Acme Engineering")
    await expect(canvas.getByRole("textbox", { name: /slug/i })).toHaveValue(
      "acme-engineering",
    )
  },
}

/** Joiner: org lit, GitHub not connected by an admin, agent step listening. */
export const JoinerListening: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
          githubInstallationNoneHandler,
          noRepositoriesHandler,
          userOnboardingHandler(null),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText(/listening for your agent’s first call/i),
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: /open ctx\|/i }),
    ).not.toBeInTheDocument()
  },
}

/** The backend recorded the first MCP call, so the agent beat is done. */
export const JoinerConnected: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
          githubInstallationNoneHandler,
          noRepositoriesHandler,
          userOnboardingHandler({
            at: "2026-09-28T09:00:00.000Z",
            client: "claude-code",
            tool: "ctx_advisor",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /open ctx\|/i })).toBeVisible(),
    )
  },
}
