import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { OnboardingGithubSlide } from "@/components/onboarding/OnboardingGithubSlide"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
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
    "https://github.com/apps/ctxpipe-agent/installations/select_target",
})

const installationNull = http.get(
  ({ request }) =>
    new URL(request.url).pathname === `/${orgSlug}/api/v1/github/installation`,
  () => HttpResponse.json(null),
)

const hostedBootstrapJson = {
  publicApiOrigin: `https://${orgSlug}.example.com`,
  suggestedWebhookUrlTemplate: `https://${orgSlug}.example.com/api/v1/webhook/github/<connectionId>`,
  githubAppConfiguredInEnv: true,
  rowsNeedingSecrets: 0,
  hostedDefaultAppInstallUrl:
    "https://github.com/apps/ctxpipe-agent/installations/select_target",
} as const

const installationLoading = http.get(
  ({ request }) =>
    new URL(request.url).pathname === `/${orgSlug}/api/v1/github/installation`,
  async () => {
    await delay("infinite")
    return HttpResponse.json(null)
  },
)

const installationInstalled = http.get(
  ({ request }) =>
    new URL(request.url).pathname === `/${orgSlug}/api/v1/github/installation`,
  () => HttpResponse.json({ id: "story-install" }),
)

const bootstrapLoading = http.get(
  ({ request }) => {
    const p = new URL(request.url).pathname
    return p === `/${orgSlug}/api/v1/github/installation/connector-bootstrap`
  },
  async () => {
    await delay("real")
    return HttpResponse.json(hostedBootstrapJson)
  },
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

export const InstallationLoading: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapHosted, installationLoading],
      },
    },
    docs: {
      description: {
        story:
          'Installation status never completes (`delay("infinite")`) so the slide stays in a loading state.',
      },
    },
  },
}

export const BootstrapLoading: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapLoading, installationNull],
      },
    },
    docs: {
      description: {
        story:
          'Connector bootstrap uses `delay("real")`, then returns hosted install URL data while installation is still absent.',
      },
    },
  },
}

export const Installed: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapHosted, installationInstalled],
      },
    },
  },
}
