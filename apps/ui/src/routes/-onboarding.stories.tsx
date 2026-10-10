import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { authClient } from "@/lib/auth-client"
import {
  authConfigHandler,
  githubInstallationNoneHandler,
  organizationFullHandler,
  organizationListEmptyHandler,
  organizationListWithOrgHandler,
  sessionSignedInOnboardingHandler,
} from "@/mocks/handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { IndexRoutePage } from "./index"
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

const onboardingJourneyRoute = {
  pattern: "flat",
  path: "/onboarding",
  alsoAt: ["/", "$"],
} satisfies StoryRouteParams

/**
 * Follows the finish navigation: `/` is the real index page, and each other
 * path shows where the user landed.
 */
function OnboardingJourney(props: { urlOrgSlug: string | null }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  if (pathname === "/onboarding")
    return <OnboardingPageContent urlOrgSlug={props.urlOrgSlug} />
  if (pathname === "/") return <IndexRoutePage />
  return <p>Landed on {pathname}</p>
}

/** A session whose `onboardingCompletedAt` the complete POST sets. */
function onboardingSession() {
  let completedAt: string | null = null
  return {
    reset: () => {
      completedAt = null
    },
    handlers: (options: { completes: boolean }) => [
      http.get("*/.auth/api/v1/auth/get-session", () =>
        HttpResponse.json({
          session: {
            id: "storybook-session",
            userId: "user_onboarding_story",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
          user: {
            id: "user_onboarding_story",
            email: "owner@story.example",
            name: "Storybook User",
            emailVerified: true,
            onboardingCompletedAt: completedAt,
          },
        }),
      ),
      http.post("*/api/v1/onboarding/user/complete", () => {
        if (options.completes) completedAt = new Date().toISOString()
        return HttpResponse.json({ completedAt })
      }),
    ],
  }
}

/** Waits until the carousel lets the button take a click. */
async function clickWhenReady(button: HTMLElement) {
  await waitFor(() =>
    expect(getComputedStyle(button).pointerEvents).not.toBe("none"),
  )
  await userEvent.click(button)
}

async function finishJoiner(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.click(
    await canvas.findByRole("button", { name: "Go to slide 4" }),
  )
  await canvas.findByRole("heading", { name: "Welcome aboard" })
  // The welcome slide also has a "Get started" button until it leaves.
  await clickWhenReady(
    await waitFor(() => canvas.getByRole("button", { name: "Get started" })),
  )
}

const joinerSession = onboardingSession()
/** A joiner finishes and lands on their Workspace, not on the welcome slide (AUTH-5). */
export const JoinerFinishLandsInApp: Story = {
  render: () => <OnboardingJourney urlOrgSlug="acme" />,
  beforeEach: joinerSession.reset,
  parameters: {
    storyRoute: onboardingJourneyRoute,
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          ...joinerSession.handlers({ completes: true }),
          organizationListWithOrgHandler,
          workspaceListHandler([docsWorkspace]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await finishJoiner(canvasElement)
    await within(canvasElement).findByText(
      "Landed on /acme/ws/docs",
      {},
      {
        timeout: 5000,
      },
    )
  },
}

const staleSession = onboardingSession()
/** The session still shows onboarding open: stay, and say so. */
export const JoinerFinishStaysWhenSessionIsStale: Story = {
  render: () => <OnboardingJourney urlOrgSlug="acme" />,
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  beforeEach: staleSession.reset,
  parameters: {
    storyRoute: onboardingJourneyRoute,
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          ...staleSession.handlers({ completes: false }),
          organizationListWithOrgHandler,
          workspaceListHandler([docsWorkspace]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await finishJoiner(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await body.findByText("Could not finish onboarding. Try again.")
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Get started" }),
    ).toBeEnabled()
    // The page fades back in after the failed finish.
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Welcome aboard" }),
      ).toBeVisible(),
    )
  },
}

const creatorSession = onboardingSession()
let creatorOrgCreated = false
/** A creator makes an organization, skips invites, and lands in the app (ONB-4). */
export const CreatorFinishLandsInApp: Story = {
  render: () => <OnboardingJourney urlOrgSlug="acme" />,
  beforeEach: () => {
    creatorSession.reset()
    creatorOrgCreated = false
  },
  parameters: {
    storyRoute: onboardingJourneyRoute,
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          ...creatorSession.handlers({ completes: true }),
          http.get("*/.auth/api/v1/auth/organization/list", () =>
            HttpResponse.json(
              creatorOrgCreated
                ? [{ id: "org_storybook", name: "Acme", slug: "acme" }]
                : [],
            ),
          ),
          http.post("*/.auth/api/v1/auth/organization/create", () => {
            creatorOrgCreated = true
            return HttpResponse.json({
              id: "org_storybook",
              name: "Acme",
              slug: "acme",
              createdAt: new Date().toISOString(),
              metadata: null,
              logo: null,
              members: [],
            })
          }),
          organizationFullHandler({
            id: "org_storybook",
            name: "Acme",
            slug: "acme",
          }),
          githubInstallationNoneHandler,
          http.post("*/.auth/api/v1/auth/organization/set-active", () =>
            HttpResponse.json({}),
          ),
          http.post("*/acme/api/v1/onboarding/complete", () =>
            HttpResponse.json({ completedAt: new Date().toISOString() }),
          ),
          workspaceListHandler([docsWorkspace]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Go to slide 6" })
    // Setup: the create slide has its own play. Create refreshes the
    // organization list that `/` reads, as the create slide does.
    await authClient.organization.create({ name: "Acme", slug: "acme" })
    // The carousel ignores a dot click while a slide transition runs.
    await waitFor(async () => {
      await userEvent.click(
        canvas.getByRole("button", { name: "Go to slide 6" }),
      )
      await canvas.findByRole(
        "heading",
        { name: "Invite team members" },
        {
          timeout: 500,
        },
      )
    })
    await clickWhenReady(
      await canvas.findByRole("button", { name: "I\u2019ll do this later" }),
    )
    await canvas.findByText("Landed on /acme/ws/docs", {}, { timeout: 5000 })
  },
}
