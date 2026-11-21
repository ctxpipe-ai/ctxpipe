import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  GITHUB_SETUP_RESULT_KEY,
  getActiveGithubPopupFlowState,
} from "@/lib/popup"
import {
  githubAppMissingHandlers,
  githubInstallationRegisterHandler,
  hostedGithubAppBootstrapHandler,
  signedInHandlers,
} from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"

const orgSlug = "acme"

const meta = preview.meta({
  title: "Components/Connections/GitHubPrerequisiteStep",
  component: GitHubPrerequisiteStep,
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, ...githubAppMissingHandlers)
  },
  parameters: {
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
})

/**
 * Step of the Slack setup dialog that asks the admin to connect GitHub first,
 * because ctxpipe writes the saved threads to a Workspace repository on GitHub.
 */
export const Slack = meta.story({
  args: {
    orgSlug,
    sourceName: "Slack",
  },
  render: (args) => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep {...args} />
    </div>
  ),
})

/**
 * Presses "Connect GitHub" with `popup` in place of `window.open`. It stops
 * each page load that follows: Chromium's Navigation API can cancel it, so the
 * button state stays on screen. Returns the URLs the page tried to load.
 */
async function pressConnect(
  canvasElement: HTMLElement,
  popup: () => Window | null,
) {
  const canvas = within(canvasElement)
  const button = await canvas.findByRole("button", { name: "Connect GitHub" })
  await waitFor(() => expect(button).not.toHaveAttribute("data-pending"))
  const destinations: string[] = []
  const stop = (event: NavigateEvent) => {
    destinations.push(event.destination.url)
    event.preventDefault()
  }
  const open = window.open
  window.navigation.addEventListener("navigate", stop)
  window.open = popup
  try {
    await userEvent.click(button)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Connect GitHub" }),
      ).toHaveAttribute("data-pending", "true"),
    )
  } finally {
    window.open = open
  }
  return {
    destinations,
    release: () => window.navigation.removeEventListener("navigate", stop),
  }
}

/** A popup that returns the installation at once and closes. */
function popupReturnsInstallation() {
  localStorage.setItem(
    GITHUB_SETUP_RESULT_KEY,
    JSON.stringify({
      installationId: 42,
      popupFlowNonce: getActiveGithubPopupFlowState()?.nonce,
    }),
  )
  return { closed: true, focus() {} } as Window
}

/**
 * GitHub handlers of an org with no installation: they count the
 * installation reads, and `register` answers the register request.
 */
function installFlow(register: () => Response) {
  const reads = { count: 0 }
  const handlers = [
    hostedGithubAppBootstrapHandler,
    http.get(`*/${orgSlug}/api/v1/github/installation`, () => {
      reads.count += 1
      return HttpResponse.json(null)
    }),
    githubInstallationRegisterHandler(register),
  ]
  return { reads, handlers }
}

/**
 * The flow refreshes the installation after it reads the popup result. Waits
 * for that read and one more task, then checks that the button is still in
 * progress.
 */
async function expectStillPending(
  canvasElement: HTMLElement,
  reads: { count: number },
) {
  await waitFor(() => expect(reads.count).toBeGreaterThan(1))
  await new Promise((resolve) => setTimeout(resolve))
  await waitFor(() =>
    expect(
      within(canvasElement).getByRole("button", { name: "Connect GitHub" }),
    ).toHaveAttribute("data-pending", "true"),
  )
}

const redirectFlow = installFlow(() =>
  HttpResponse.json(
    { error: "Refused", why: "github_authorization_unavailable" },
    { status: 403 },
  ),
)

/**
 * The admin installed the App in the popup, and ctxpipe sends the page to
 * GitHub setup to prove access. The button stays in progress until the page
 * unloads.
 */
export const RedirectKeepsPending = meta.story({
  ...Slack.input,
  beforeEach: ({ msw }) => {
    msw.use(...redirectFlow.handlers)
  },
  play: async ({ canvasElement }) => {
    redirectFlow.reads.count = 0
    const { destinations, release } = await pressConnect(
      canvasElement,
      popupReturnsInstallation,
    )
    try {
      await waitFor(() =>
        expect(destinations.join(" ")).toContain("/.github/setup"),
      )
      await expectStillPending(canvasElement, redirectFlow.reads)
    } finally {
      release()
    }
  },
})

/** The browser blocked the popup, so the page itself goes to GitHub. */
export const BlockedPopupKeepsPending = meta.story({
  ...Slack.input,
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Slack." },
  },
  play: async ({ canvasElement }) => {
    const { destinations, release } = await pressConnect(
      canvasElement,
      () => null,
    )
    release()
    await expect(destinations.join(" ")).toContain(
      "https://github.com/apps/ctxpipe",
    )
    // Back from GitHub restores the page from the back/forward cache: the
    // user can start again.
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    )
    await waitFor(() =>
      expect(
        within(canvasElement).getByRole("button", { name: "Connect GitHub" }),
      ).not.toHaveAttribute("data-pending"),
    )
  },
})

const registerFlow = installFlow(() => HttpResponse.json({ ok: true }))

/**
 * GitHub connected in the popup, and the caller opens the next step. The
 * button stays in progress while that step loads.
 */
export const RegisteredKeepsPending = meta.story({
  ...Slack.input,
  args: {
    ...Slack.input.args,
    // The next step is a page load that does not end while the story runs.
    onConnected: () =>
      new Promise<void>(() => window.location.assign("/acme/next-step")),
  },
  beforeEach: ({ msw }) => {
    msw.use(...registerFlow.handlers)
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as RedirectKeepsPending.",
    },
  },
  play: async ({ canvasElement }) => {
    registerFlow.reads.count = 0
    const { destinations, release } = await pressConnect(
      canvasElement,
      popupReturnsInstallation,
    )
    try {
      await waitFor(() =>
        expect(destinations.join(" ")).toContain("/acme/next-step"),
      )
      await expectStillPending(canvasElement, registerFlow.reads)
    } finally {
      release()
    }
  },
})
