import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { OnboardingGithubSlide } from "@/components/onboarding/OnboardingGithubSlide"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"

const orgSlug = "acme"

const bootstrapSelfHosted = githubConnectorBootstrapHandler({
  orgSlug,
  hostedDefaultAppInstallUrl: null,
  githubAppConfiguredInEnv: false,
})

const bootstrapHosted = githubConnectorBootstrapHandler({
  orgSlug,
  hostedDefaultAppInstallUrl:
    "https://github.com/apps/ctxpipe-agent/installations/select_target",
})

const installationNull = http.get(
  ({ request }) =>
    new URL(request.url).pathname === `/${orgSlug}/api/v1/github/installation`,
  () => HttpResponse.json(null),
)

const meta = {
  title: "Components/Onboarding/GithubSlide",
  component: OnboardingGithubSlide,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-none border border-border bg-zinc-950 p-8 text-left">
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
} satisfies Meta<typeof OnboardingGithubSlide>

export default meta

type Story = StoryObj<typeof meta>

export const HostedNoInstallation: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapHosted, installationNull],
      },
    },
  },
}

export const SelfHostedNoInstallation: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapSelfHosted, installationNull],
      },
    },
  },
}
