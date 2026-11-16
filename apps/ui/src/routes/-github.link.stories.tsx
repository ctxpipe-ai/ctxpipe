import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, waitFor, within } from "storybook/test"

import { GITHUB_POPUP_FLOW_KEY, GITHUB_SETUP_RESULT_KEY } from "@/lib/popup"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { GithubLinkStep } from "./[.]github.link"

const meta = {
  title: "Pages/GitHub link",
  tags: ["page"],
  parameters: {
    msw: { handlers: { session: signedInHandlers } },
    app: "root",
    queryClient: true,
    layout: "fullscreen",
    route: "/.github/link",
    storyRoute: {
      pattern: "flat",
      path: "/.github/link",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

const install =
  "https://github.com/apps/ctxpipe/installations/new?state=story-flow"

/** The connect flow that the opener started, with the nonce in `install`. */
function startFlow() {
  localStorage.setItem(
    GITHUB_POPUP_FLOW_KEY,
    JSON.stringify({ nonce: "story-flow", startedAtMs: Date.now() }),
  )
  return () => {
    localStorage.removeItem(GITHUB_POPUP_FLOW_KEY)
    localStorage.removeItem(GITHUB_SETUP_RESULT_KEY)
  }
}

/**
 * The GitHub account belongs to another ctxpipe user. The page names GitHub,
 * and it leaves the error, with the flow nonce, for the opener.
 */
export const LinkedToAnotherUser: Story = {
  parameters: {
    review: {
      purpose:
        "Popup step of the GitHub account link: the account is already linked to another ctxpipe user.",
    },
  },
  render: () => (
    <GithubLinkStep
      next={install}
      linked={false}
      error="account_already_linked_to_different_user"
    />
  ),
  beforeEach: startFlow,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", {
          name: "Could not link your GitHub account",
        }),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(
          /This GitHub account is linked to another ctxpipe user/,
        ),
      ).toBeVisible(),
    )
    await expect(canvas.queryByText(/Atlassian/)).not.toBeInTheDocument()
    await expect(
      JSON.parse(localStorage.getItem(GITHUB_SETUP_RESULT_KEY) ?? "null"),
    ).toEqual({
      linkError: "account_already_linked_to_different_user",
      popupFlowNonce: "story-flow",
    })
  },
}

/** `next` is a GitHub page that is not an App install: the page goes nowhere. */
export const RefusesOtherAddress: Story = {
  parameters: {
    review: {
      purpose:
        "Popup step of the GitHub account link: the next address is not a GitHub App install, so the step says the link is not valid.",
    },
  },
  render: () => (
    <GithubLinkStep
      next="https://github.com/login/oauth/authorize?client_id=other&state=story-flow"
      linked={true}
      error={undefined}
    />
  ),
  beforeEach: startFlow,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText(
          "This link is not valid. Close this window and connect GitHub again.",
        ),
      ).toBeVisible(),
    )
  },
}

const linkRequest = fn()
/**
 * Another site sends a signed-in user here. With no connect flow from this
 * app, the page links nothing and writes nothing.
 */
export const RefusesWithoutConnectFlow: Story = {
  render: () => (
    <GithubLinkStep
      next={install}
      linked={false}
      error="account_already_linked_to_different_user"
    />
  ),
  beforeEach: () => {
    linkRequest.mockClear()
    // Other stories in this browser leave a flow behind.
    localStorage.removeItem(GITHUB_POPUP_FLOW_KEY)
    localStorage.removeItem(GITHUB_SETUP_RESULT_KEY)
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as RefusesOtherAddress.",
    },
    review: {
      purpose:
        "Popup step of the GitHub account link: no connect flow started in this app, so the step links nothing and says the link is not valid.",
    },
    msw: {
      handlers: {
        page: [
          http.post("*/.auth/api/v1/auth/link-social", () => {
            linkRequest()
            return HttpResponse.json({ url: install, redirect: false })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText(
          "This link is not valid. Close this window and connect GitHub again.",
        ),
      ).toBeVisible(),
    )
    await expect(linkRequest).not.toHaveBeenCalled()
    await expect(localStorage.getItem(GITHUB_SETUP_RESULT_KEY)).toBeNull()
  },
}

const linkSocial = fn()
/**
 * No GitHub account yet: the page links one, and comes back here with
 * `linked=1` (or with the error) before it goes on to the install.
 */
export const LinksWhenNoGithubAccount: Story = {
  render: () => (
    <GithubLinkStep next={install} linked={false} error={undefined} />
  ),
  beforeEach: () => {
    linkSocial.mockClear()
    return startFlow()
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as ChecksAccountsBeforeLinking.",
    },
    review: {
      purpose:
        "Popup step of the GitHub account link: the user has no GitHub account yet, so the step starts the link and shows a spinner.",
    },
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/list-accounts", () =>
            HttpResponse.json([]),
          ),
          http.post("*/.auth/api/v1/auth/link-social", async ({ request }) => {
            linkSocial(await request.json())
            // No redirect: the story stays on this page.
            return HttpResponse.json({ url: install, redirect: false })
          }),
        ],
      },
    },
  },
  play: async () => {
    await waitFor(() => expect(linkSocial).toHaveBeenCalledTimes(1))
    const back = `/.github/link?${new URLSearchParams({ next: install })}`
    await expect(linkSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        callbackURL: `${back}&linked=1`,
        errorCallbackURL: back,
      }),
    )
  },
}

const listRequest = fn()
const earlyLink = fn()
/**
 * The page asks which accounts the user has before it links. While that
 * request is open, no link request goes out.
 */
export const ChecksAccountsBeforeLinking: Story = {
  render: () => (
    <GithubLinkStep next={install} linked={false} error={undefined} />
  ),
  beforeEach: () => {
    listRequest.mockClear()
    earlyLink.mockClear()
    return startFlow()
  },
  parameters: {
    review: {
      purpose:
        "Popup step of the GitHub account link: the account list request is still open, so the step waits with a spinner.",
    },
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/list-accounts", async () => {
            listRequest()
            await delay("infinite")
            return HttpResponse.json([])
          }),
          http.post("*/.auth/api/v1/auth/link-social", () => {
            earlyLink()
            return HttpResponse.json({ url: install, redirect: false })
          }),
        ],
      },
    },
  },
  play: async () => {
    await waitFor(() => expect(listRequest).toHaveBeenCalledTimes(1))
    await expect(earlyLink).not.toHaveBeenCalled()
  },
}
