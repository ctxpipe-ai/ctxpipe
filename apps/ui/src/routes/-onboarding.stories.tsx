import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { authClient } from "@/lib/auth-client"
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

/**
 * A joiner finishes onboarding. The session that `/` reads must already show
 * the completion, or `/` sends the user back to the welcome slide.
 */
let joinerCompletedAt: string | null = null
export const JoinerFinishRefreshesSession: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  beforeEach: () => {
    joinerCompletedAt = null
  },
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          http.get("*/.auth/api/v1/auth/get-session", () =>
            HttpResponse.json({
              session: {
                id: "storybook-session",
                userId: "user_onboarding_story",
                expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              },
              user: {
                id: "user_onboarding_story",
                email: "joiner@story.example",
                name: "Storybook User",
                emailVerified: true,
                onboardingCompletedAt: joinerCompletedAt,
              },
            }),
          ),
          http.post("*/api/v1/onboarding/user/complete", () => {
            joinerCompletedAt = new Date().toISOString()
            return HttpResponse.json({ ok: true })
          }),
          organizationListWithOrgHandler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Go to slide 4" }),
    )
    await canvas.findByRole("heading", { name: "Welcome aboard" })
    // The welcome slide also has a "Get started" button until it leaves.
    const finish = await waitFor(() =>
      canvas.getByRole("button", { name: "Get started" }),
    )
    // The carousel blocks pointer events until the slide transition ends.
    await waitFor(() =>
      expect(getComputedStyle(finish).pointerEvents).not.toBe("none"),
    )
    // Keep the session atom mounted, as the `/` page does. A read of an
    // unmounted atom fetches the session again and hides a stale value.
    const session = authClient.$store.atoms.session
    const stopListening = session.listen(() => {})
    let completedWhenLeaving: unknown = "not left"
    const leaving = new Promise<void>((resolve) => {
      const setItem = sessionStorage.setItem.bind(sessionStorage)
      sessionStorage.setItem = (key, value) => {
        setItem(key, value)
        if (key !== "ctxpipe:app-shell-fade-in") return
        completedWhenLeaving = (
          session.get().data as {
            user?: { onboardingCompletedAt?: string | null }
          } | null
        )?.user?.onboardingCompletedAt
        sessionStorage.setItem = setItem
        resolve()
      }
    })
    try {
      await userEvent.click(finish)
      await leaving
      // `/` reads this atom when the page leaves. A stale value sends the
      // user back to the welcome slide.
      await expect(completedWhenLeaving).toBeTruthy()
    } finally {
      stopListening()
    }
  },
}
