import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, within } from "storybook/test"
import { OnboardingGithubSlide } from "@/components/onboarding/OnboardingGithubSlide"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import {
  githubInstallationLinkedHandler,
  githubInstallationNoneHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const orgSlug = "acme"

const bootstrapSelfHosted = githubConnectorBootstrapHandler({
  orgSlug,
  hostedDefaultAppInstallUrl: null,
  githubAppConfiguredInEnv: false,
})

const bootstrapHosted = githubConnectorBootstrapHandler({
  orgSlug,
  hostedDefaultAppInstallUrl:
    "https://github.com/apps/ctxpipe-agent/installations/new",
})

const installationLoading = http.get(
  ({ request }) =>
    new URL(request.url).pathname === `/${orgSlug}/api/v1/github/installation`,
  async () => {
    await delay("infinite")
    return HttpResponse.json(null)
  },
)

const meta = {
  title: "Components/Onboarding/GithubSlide",
  component: OnboardingGithubSlide,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-md border border-border bg-zinc-950 p-8 text-center">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug,
    onFinish: fn(),
  },
} satisfies Meta<typeof OnboardingGithubSlide>

export default meta

type Story = StoryObj<typeof meta>

/** "Skip for now" finishes onboarding without GitHub. */
export const HostedNoInstallation: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapHosted, githubInstallationNoneHandler],
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled()
    await userEvent.click(canvas.getByRole("button", { name: "Skip for now" }))
    await expect(args.onFinish).toHaveBeenCalledTimes(1)
  },
}

export const SelfHostedNoInstallation: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapSelfHosted, githubInstallationNoneHandler],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("button", { name: "Set up GitHub App" }),
    ).toBeEnabled()
  },
}

export const Checking: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapHosted, installationLoading],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("button", { name: "Checking..." }),
    ).toBeDisabled()
  },
}

/** GitHub was already linked on arrival: one "Continue" finishes onboarding. */
export const Connected: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapHosted, githubInstallationLinkedHandler],
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "GitHub is connected" })
    expect(
      canvas.queryByRole("button", { name: "Skip for now" }),
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }))
    await expect(args.onFinish).toHaveBeenCalledTimes(1)
  },
}
