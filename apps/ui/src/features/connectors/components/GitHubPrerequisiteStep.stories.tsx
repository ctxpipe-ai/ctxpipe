import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  GITHUB_SETUP_RESULT_KEY,
  getActiveGithubPopupFlowState,
} from "@/lib/popup"
import {
  githubAppMissingHandlers,
  hostedGithubAppBootstrapHandler,
  signedInHandlers,
} from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/GitHubPrerequisiteStep",
  component: GitHubPrerequisiteStep,
  parameters: {
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
    msw: {
      handlers: { session: signedInHandlers, github: githubAppMissingHandlers },
    },
  },
} satisfies Meta<typeof GitHubPrerequisiteStep>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Step of the Slack setup dialog that asks the admin to connect GitHub first,
 * because ctxpipe writes the saved threads to a Workspace repository on GitHub.
 */
export const Slack: Story = {
  args: {
    orgSlug,
    sourceName: "Slack",
  },
  render: (args) => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep {...args} />
    </div>
  ),
}

/**
 * Presses "Connect GitHub" with `popup` in place of `window.open`, and stops
 * the page load that follows. Chromium's Navigation API can cancel it, so the
 * button state stays on screen. Returns the URL the page tried to load.
 */
async function connectUntilNavigation(
  canvasElement: HTMLElement,
  popup: () => Window | null,
) {
  const canvas = within(canvasElement)
  const button = await canvas.findByRole("button", { name: "Connect GitHub" })
  await waitFor(() => expect(button).not.toHaveAttribute("data-pending"))
  let destination: string | undefined
  const stop = (event: NavigateEvent) => {
    destination = event.destination.url
    event.preventDefault()
  }
  const open = window.open
  window.navigation.addEventListener("navigate", stop)
  window.open = popup
  try {
    await userEvent.click(button)
    await waitFor(() => expect(destination).toBeDefined())
  } finally {
    window.open = open
    window.navigation.removeEventListener("navigate", stop)
  }
  return { button, destination: destination ?? "" }
}

/** Reads of the installation in RedirectKeepsPending; its play resets it. */
let installationReads = 0

/**
 * The admin installed the App in the popup, and ctxpipe sends the page to
 * GitHub setup to prove access. The button stays in progress until the page
 * unloads.
 */

export const RedirectKeepsPending: Story = {
  ...Slack,
  parameters: {
    msw: {
      handlers: {
        github: [
          hostedGithubAppBootstrapHandler,
          http.get(`*/${orgSlug}/api/v1/github/installation`, () => {
            installationReads += 1
            return HttpResponse.json(null)
          }),
        ],
        register: http.post(`*/${orgSlug}/api/v1/github/installation`, () =>
          HttpResponse.json(
            { error: "Refused", why: "github_authorization_unavailable" },
            { status: 403 },
          ),
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    installationReads = 0
    const { button, destination } = await connectUntilNavigation(
      canvasElement,
      () => {
        // The popup returns the installation at once and closes.
        localStorage.setItem(
          GITHUB_SETUP_RESULT_KEY,
          JSON.stringify({
            installationId: 42,
            popupFlowNonce: getActiveGithubPopupFlowState()?.nonce,
          }),
        )
        return { closed: true, focus() {} } as Window
      },
    )
    await expect(destination).toContain("/.github/setup")
    // The flow refreshes the installation after the navigation starts. Wait
    // for that read and one more task, then check that the button did not go
    // back to idle.
    await waitFor(() => expect(installationReads).toBeGreaterThan(1))
    await new Promise((resolve) => setTimeout(resolve))
    await expect(button).toHaveAttribute("data-pending", "true")
  },
}

/** The browser blocked the popup, so the page itself goes to GitHub. */
export const BlockedPopupKeepsPending: Story = {
  ...Slack,
  parameters: { visual: { skip: "Same screen as RedirectKeepsPending." } },
  play: async ({ canvasElement }) => {
    const { button, destination } = await connectUntilNavigation(
      canvasElement,
      () => null,
    )
    await expect(destination).toContain("https://github.com/apps/ctxpipe")
    await expect(button).toHaveAttribute("data-pending", "true")
  },
}
