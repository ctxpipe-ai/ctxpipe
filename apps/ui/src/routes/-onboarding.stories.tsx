import type { Meta, StoryObj } from "@storybook/react-vite"
import { useLocation } from "@tanstack/react-router"
import { delay, HttpResponse, http, type RequestHandler } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { onboardingHandOffFlag } from "@/lib/session-flags"
import {
  authConfigHandler,
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
  render: () => <OnboardingPageContent />,
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

/** New admin user, no organization yet: the first slide, the welcome. */
export const AdminFlowHowItWorks: Story = {
  render: () => <OnboardingPageContent />,
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
 * Follows the navigation after onboarding: `/` is the real index page, and
 * each other path shows where the user landed, and if onboarding sent the
 * user there (Home then fades in).
 */
function OnboardingJourney() {
  const { pathname } = useLocation()
  if (pathname === "/onboarding") return <OnboardingPageContent />
  if (pathname === "/") return <IndexRoutePage />
  return (
    <p>
      Landed on {pathname}
      {onboardingHandOffFlag.isSet() ? " from onboarding" : ""}
    </p>
  )
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

/** A joiner has one slide. "Get started" on How it works finishes. */
async function finishJoiner(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await canvas.findByRole("heading", { name: "Welcome to ctxpipe" })
  expect(
    canvas.queryByRole("button", { name: /^Go to slide/ }),
  ).not.toBeInTheDocument()
  await userEvent.click(canvas.getByRole("button", { name: "Get started" }))
}

const joinerSession = onboardingSession()
/** A joiner finishes and lands on Home, where the setup guide is (AUTH-5). */
export const JoinerFinishLandsInApp: Story = {
  tags: ["workspace-golden"],
  render: () => <OnboardingJourney />,
  beforeEach: joinerSession.reset,
  parameters: {
    intent:
      "Catches a joiner who finishes onboarding and does not reach the app. The finish step completes onboarding and opens the organization. Not for the create-organization flow.",
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
      "Landed on /acme from onboarding",
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
  render: () => <OnboardingJourney />,
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
        canvas.getByRole("heading", { name: "Welcome to ctxpipe" }),
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
 * A new admin reads the welcome slide, creates the organization, and lands
 * on Home. There is no Connect GitHub slide: the Get started guide on Home
 * has that step.
 */
export const AdminFlowCreateOrgLandsOnHome: Story = {
  tags: ["workspace-golden"],
  render: () => <OnboardingJourney />,
  beforeEach: () => {
    creatorSession.reset()
    creatorState.orgCreated = false
    creatorState.orgCompleted = false
  },
  parameters: {
    intent:
      "Catches an admin onboarding that does not create the organization or open its home. Two steps, with the name and slug taken from the session email. Not for the joiner flow.",
    storyRoute: onboardingJourneyRoute,
    msw: {
      handlers: {
        defaults: creatorHandlers(creatorSession, creatorState, [
          workspaceListHandler([]),
        ]),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Welcome to ctxpipe" })
    // Two steps, Next then Create organization, and no slide buttons.
    expect(
      canvas.queryByRole("button", { name: /^Go to slide/ }),
    ).not.toBeInTheDocument()
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
    // Create organization opens Home at once: no Connect GitHub slide.
    await canvas.findByText("Landed on /acme from onboarding")
    // The owner's finish also completes the organization.
    expect(creatorState.orgCompleted).toBe(true)
  },
}

const retrySession = onboardingSession()
const retryState = { orgCreated: false, orgCompleted: false }
const retryCreate = fn()
/**
 * The organization exists, but onboarding does not complete on the first
 * try. The button reads "Continue" and completes onboarding; it does not
 * create the organization a second time.
 */
export const AdminFinishFailureContinues: Story = {
  render: () => <OnboardingJourney />,
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  beforeEach: () => {
    retrySession.reset()
    retryState.orgCreated = false
    retryState.orgCompleted = false
    retryCreate.mockClear()
  },
  parameters: {
    storyRoute: onboardingJourneyRoute,
    msw: {
      handlers: {
        defaults: [
          http.post(
            "*/api/v1/onboarding/user/complete",
            () => HttpResponse.json({ error: "failed" }, { status: 500 }),
            { once: true },
          ),
          // Counts each request that creates an organization, then the next
          // handler answers it.
          http.post("*/.auth/api/v1/auth/organization/create", () => {
            retryCreate()
          }),
          ...creatorHandlers(retrySession, retryState, [
            workspaceListHandler([]),
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Next" }))
    const name = await canvas.findByRole("textbox", {
      name: "Organization name",
    })
    await userEvent.clear(name)
    await userEvent.type(name, "Acme")
    await userEvent.click(
      canvas.getByRole("button", { name: "Create organization" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    await body.findByText("Could not finish onboarding. Try again.")
    const proceed = await canvas.findByRole("button", { name: "Continue" })
    await waitFor(() => expect(proceed).toBeEnabled())
    await waitFor(() =>
      expect(
        canvas.getByRole("textbox", {
          name: "Organization name",
        }),
      ).toBeDisabled(),
    )
    await userEvent.click(proceed)
    await canvas.findByText("Landed on /acme from onboarding")
    expect(retryCreate).toHaveBeenCalledTimes(1)
  },
}

const doubleClickCreate = fn()
/**
 * A double-click on a slide button moves one slide. The slide changes at
 * once, so the second click (detail 2) can land on the next slide's button.
 * Here that button creates the organization, so the second click must not
 * count.
 */
export const DoubleClickMovesOneSlide: Story = {
  tags: ["workspace-golden"],
  render: () => <OnboardingPageContent />,
  beforeEach: () => {
    doubleClickCreate.mockClear()
  },
  parameters: {
    intent:
      "Catches a fast double click on Next that skips a slide or creates an organization. One double click moves one slide and sends no create request. Not for the slide content.",
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListEmptyHandler,
          http.post("*/.auth/api/v1/auth/organization/create", () => {
            doubleClickCreate()
            return HttpResponse.json({ error: "not expected" }, { status: 500 })
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
    await canvas.findByRole("button", { name: "Next" })
    click("Next", 1)
    await canvas.findByRole("heading", { name: "Create your organization" })
    click("Create organization", 2)
    // Let React commit any change before the check.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(
      canvas.getByRole("button", { name: "Create organization" }),
    ).toBeEnabled()
    expect(doubleClickCreate).not.toHaveBeenCalled()
  },
}
