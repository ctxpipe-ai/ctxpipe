import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { githubAppMissingHandlers, signedInHandlers } from "@/mocks/handlers"

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
 * The admin installed the App in the popup, and ctxpipe sends the page to
 * GitHub setup to prove access. The button stays in progress until the page
 * unloads. The story stops the navigation, so the state stays on screen.
 */
export const RedirectKeepsPending: Story = {
  args: { orgSlug, sourceName: "Slack" },
  parameters: {
    msw: {
      handlers: {
        register: http.post(`*/${orgSlug}/api/v1/github/installation`, () =>
          HttpResponse.json(
            { error: "Refused", why: "github_authorization_unavailable" },
            { status: 403 },
          ),
        ),
      },
    },
  },
  render: Slack.render,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const navigations: string[] = []
    // Chromium's Navigation API can cancel a same-origin page load.
    const nav = (
      window as unknown as {
        navigation: EventTarget
      }
    ).navigation
    const stop = (event: Event) => {
      const e = event as Event & { destination: { url: string } }
      navigations.push(e.destination.url)
      e.preventDefault()
    }
    nav.addEventListener("navigate", stop)
    const open = window.open
    // The popup returns the installation at once and closes.
    window.open = () => {
      const flow = JSON.parse(localStorage.getItem("github-popup-flow") ?? "{}")
      localStorage.setItem(
        "github-setup-result",
        JSON.stringify({ installationId: 42, popupFlowNonce: flow.nonce }),
      )
      return { closed: true, focus() {} } as unknown as Window
    }
    try {
      const button = await canvas.findByRole("button", {
        name: "Connect GitHub",
      })
      await waitFor(() => expect(button).not.toHaveAttribute("data-pending"))
      await userEvent.click(button)
      await waitFor(() =>
        expect(navigations.some((url) => url.includes("/.github/setup"))).toBe(
          true,
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      await expect(button).toHaveAttribute("data-pending", "true")
    } finally {
      window.open = open
      nav.removeEventListener("navigate", stop)
    }
  },
}
