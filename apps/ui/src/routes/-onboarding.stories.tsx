import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  authConfigHandler,
  organizationListEmptyHandler,
  organizationListWithOrgHandler,
  sessionSignedInOnboardingHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OnboardingPageContent } from "./onboarding"

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

export const Loading: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/get-session", async () => {
            await delay("infinite")
            return HttpResponse.json(null)
          }),
          http.get("*/.auth/api/v1/auth/organization/list", async () => {
            await delay("infinite")
            return HttpResponse.json([])
          }),
        ],
      },
    },
  },
}

/** New admin user, no organisation yet — welcome slide in the carousel. */
export const AdminFlowWelcome: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    msw: {
      handlers: {
        page: [sessionSignedInOnboardingHandler, organizationListEmptyHandler],
      },
    },
  },
}

/** The manual MCP snippet names this deployment's origin, not the hosted app. */
export const McpSnippetUsesCurrentOrigin: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  parameters: {
    msw: {
      handlers: {
        // Replaces the preview's signed-in user, who has finished onboarding.
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Go to slide 3" }),
    )
    const manual = await canvas.findByRole("button", {
      name: /install manually/i,
    })
    // The carousel blocks pointer events until the slide transition ends.
    await waitFor(() =>
      expect(getComputedStyle(manual).pointerEvents).not.toBe("none"),
    )
    await userEvent.click(manual)
    const snippet = await waitFor(() => {
      const code = canvasElement.querySelector("pre code")
      expect(code).not.toBeNull()
      return code?.textContent ?? ""
    })
    expect(snippet).toContain(
      `"url": "${window.location.origin}/mcp?orgSlug=acme"`,
    )
    expect(snippet).not.toContain("app.ctxpipe.ai")
  },
}
