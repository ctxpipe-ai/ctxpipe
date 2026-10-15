import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { delay, HttpResponse, http, type RequestHandler } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { authClient } from "@/lib/auth-client"
import {
  authConfigHandler,
  githubInstallationLinkedHandler,
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

/** New admin user, no organization yet: the welcome slide of the carousel. */
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

const onboardingJourneyRoute = {
  pattern: "flat",
  path: "/onboarding",
  alsoAt: ["/", "$"],
} satisfies StoryRouteParams

/**
 * Follows the finish navigation: `/` is the real index page, and each other
 * path shows where the user landed. Like the real route, the page reads
 * `orgSlug` from the URL: onboarding writes it there after it creates the
 * organization. A fixed prop made the page redirect to itself without end
 * when the new organization arrived in the list before the finish navigated.
 */
function OnboardingJourney(props: { urlOrgSlug: string | null }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const searchOrgSlug = useRouterState({
    select: (state) => {
      const value = (state.location.search as { orgSlug?: unknown }).orgSlug
      return typeof value === "string" ? value : null
    },
  })
  if (pathname === "/onboarding")
    return (
      <OnboardingPageContent urlOrgSlug={searchOrgSlug ?? props.urlOrgSlug} />
    )
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
    handlers: (options: { completes: boolean; role?: string }) => [
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
      http.post("*/.auth/api/v1/auth/organization/set-active", () =>
        HttpResponse.json({}),
      ),
      http.get("*/.auth/api/v1/auth/organization/get-active-member-role", () =>
        HttpResponse.json({ role: options.role ?? "member" }),
      ),
    ],
  }
}

/** A joiner has two slides. "Get started" on How it works finishes. */
async function finishJoiner(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.click(
    await canvas.findByRole("button", { name: "Go to slide 2" }),
  )
  await canvas.findByRole("heading", { name: "How ctx| works" })
  expect(
    canvas.queryByRole("button", { name: "Go to slide 3" }),
  ).not.toBeInTheDocument()
  await userEvent.click(canvas.getByRole("button", { name: "Get started" }))
}

const joinerSession = onboardingSession()
/** A joiner finishes and lands on Home, where the setup guide is (AUTH-5). */
export const JoinerFinishLandsInApp: Story = {
  tags: ["workspace-golden"],
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
      "Landed on /acme",
      {},
      {
        timeout: 15_000,
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
        canvas.getByRole("heading", { name: "How ctx| works" }),
      ).toBeVisible(),
    )
  },
}

/** Handlers for an admin who has no organization on arrival. */
function creatorHandlers(
  session: ReturnType<typeof onboardingSession>,
  state: { orgCreated: boolean; orgCompleted: boolean },
  extra: RequestHandler[],
) {
  return [
    authConfigHandler,
    ...session.handlers({ completes: true, role: "owner" }),
    http.get("*/.auth/api/v1/auth/organization/list", () =>
      HttpResponse.json(
        state.orgCreated
          ? [{ id: "org_storybook", name: "Acme", slug: "acme" }]
          : [],
      ),
    ),
    http.post("*/.auth/api/v1/auth/organization/create", () => {
      state.orgCreated = true
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
    http.post("*/acme/api/v1/onboarding/complete", () => {
      state.orgCompleted = true
      return HttpResponse.json({ completedAt: new Date().toISOString() })
    }),
    ...extra,
  ]
}

const creatorSession = onboardingSession()
const creatorState = { orgCreated: false, orgCompleted: false }
/**
 * A new admin steps through the four slides with the slide buttons, skips
 * GitHub, and lands on Home, because the new organization has no Workspace.
 */
export const AdminFlowSkipGithubLandsOnHome: Story = {
  // Reduced motion shows the hero at once, so the play does not wait on the typing timer.
  tags: ["workspace-golden", "reduced-motion"],
  render: () => <OnboardingJourney urlOrgSlug={null} />,
  beforeEach: () => {
    creatorSession.reset()
    creatorState.orgCreated = false
    creatorState.orgCompleted = false
  },
  parameters: {
    storyRoute: onboardingJourneyRoute,
    msw: {
      handlers: {
        defaults: creatorHandlers(creatorSession, creatorState, [
          githubInstallationNoneHandler,
          workspaceListHandler([]),
        ]),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The reveal runs in an effect, so the button can still be transparent at first.
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Get started" })).toBeVisible(),
    )
    await userEvent.click(canvas.getByRole("button", { name: "Get started" }))
    await canvas.findByRole("heading", { name: "How ctx| works" })
    expect(
      canvas.getAllByRole("button", { name: /^Go to slide/ }),
    ).toHaveLength(4)
    await userEvent.click(canvas.getByRole("button", { name: "Next" }))
    await canvas.findByRole("heading", { name: "Create your organization" })
    // The session email domain gives the first name, and the slug follows it.
    const name = canvas.getByRole("textbox", { name: "Organization name" })
    await expect(name).toHaveValue("Story")
    await expect(canvas.getByRole("textbox", { name: "Slug URL" })).toHaveValue(
      "story",
    )
    await userEvent.clear(name)
    await userEvent.type(name, "Acme")
    await expect(canvas.getByRole("textbox", { name: "Slug URL" })).toHaveValue(
      "acme",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create organization" }),
    )
    await canvas.findByRole("heading", { name: "Connect GitHub" })
    await userEvent.click(
      await canvas.findByRole("button", { name: "Skip for now" }),
    )
    await canvas.findByText("Landed on /acme", {}, { timeout: 15_000 })
    // The owner's finish also completes the organization.
    expect(creatorState.orgCompleted).toBe(true)
  },
}

const connectedSession = onboardingSession()
const connectedState = { orgCreated: false, orgCompleted: false }
/** GitHub is already linked on the GitHub slide: "Continue" finishes onboarding. */
export const GithubConnectedContinueFinishes: Story = {
  tags: ["workspace-golden"],
  render: () => <OnboardingJourney urlOrgSlug="acme" />,
  beforeEach: () => {
    connectedSession.reset()
    connectedState.orgCreated = false
    connectedState.orgCompleted = false
  },
  parameters: {
    storyRoute: onboardingJourneyRoute,
    msw: {
      handlers: {
        defaults: creatorHandlers(connectedSession, connectedState, [
          githubInstallationLinkedHandler,
          workspaceListHandler([docsWorkspace]),
        ]),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Go to slide 4" })
    // Setup: the create slide has its own play. Create refreshes the
    // organization list that `/` reads, as the create slide does.
    await authClient.organization.create({ name: "Acme", slug: "acme" })
    await userEvent.click(canvas.getByRole("button", { name: "Go to slide 4" }))
    await canvas.findByRole("heading", { name: "GitHub is connected" })
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }))
    // A new user lands on Home, also when the org has a Workspace.
    await canvas.findByText("Landed on /acme", {}, { timeout: 15_000 })
  },
}

const doubleClickComplete = fn()
/**
 * A double-click on a slide button moves one slide. The slide changes at
 * once, so the second click (detail 2) can land on the next slide's button.
 * Here that button finishes onboarding, so the second click must not count.
 */
export const DoubleClickMovesOneSlide: Story = {
  tags: ["workspace-golden"],
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  beforeEach: () => {
    doubleClickComplete.mockClear()
  },
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
          http.post("*/api/v1/onboarding/user/complete", () => {
            doubleClickComplete()
            return HttpResponse.json({ completedAt: null })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const click = (name: string, detail: number) =>
      canvas
        .getByRole("button", { name })
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail }))
    await canvas.findByRole("button", { name: "Get started" })
    click("Get started", 1)
    await canvas.findByRole("heading", { name: "How ctx| works" })
    click("Get started", 2)
    // Let React commit any change before the check.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(
      canvas.getByRole("heading", { name: "How ctx| works" }),
    ).toBeVisible()
    expect(canvas.getByRole("button", { name: "Get started" })).toBeEnabled()
    expect(doubleClickComplete).not.toHaveBeenCalled()
  },
}
