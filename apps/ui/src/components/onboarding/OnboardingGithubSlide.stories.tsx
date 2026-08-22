import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { OnboardingGithubSlide } from "@/components/onboarding/OnboardingGithubSlide"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"

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
    "https://github.com/apps/ctxpipe-agent/installations/new",
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

const workspacesLoading = http.get(
  ({ request }) => /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
  async () => {
    await delay("infinite")
    return HttpResponse.json({ items: [], lastUsedWorkspaceId: null })
  },
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
      <div className="max-w-xl rounded-none border border-border bg-zinc-950 p-8 text-center">
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

export const InstalledEmpty: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          bootstrapHosted,
          installationInstalled,
          workspaceListHandler([]),
        ],
      },
    },
  },
}

export const InstalledPopulated: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          bootstrapHosted,
          installationInstalled,
          workspaceListHandler([docsWorkspace]),
        ],
      },
    },
  },
}

export const InstalledLoading: Story = {
  args: {
    orgSlug,
    onContinue: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        page: [bootstrapHosted, installationInstalled, workspacesLoading],
      },
    },
  },
}
