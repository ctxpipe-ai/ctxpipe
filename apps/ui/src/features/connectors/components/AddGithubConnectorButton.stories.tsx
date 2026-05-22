import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { githubConnectorBootstrapHandler } from "../mocks/github-bootstrap-msw"
import { AddGithubConnectorButton } from "./AddGithubConnectorButton"

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

const meta = {
  title: "Components/Connections/GitHub/AddButton",
  component: AddGithubConnectorButton,
  decorators: [
    (Story) => (
      <div className="w-96">
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
} satisfies Meta<typeof AddGithubConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const NoInstallation: Story = {
  render: () => <AddGithubConnectorButton orgSlug={orgSlug} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          bootstrapHosted,
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/github/installation",
              ),
            () => HttpResponse.json(null),
          ),
        ],
      },
    },
  },
}

export const NoInstallationSelfHosted: Story = {
  render: () => <AddGithubConnectorButton orgSlug={orgSlug} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          bootstrapSelfHosted,
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/github/installation",
              ),
            () => HttpResponse.json(null),
          ),
        ],
      },
    },
  },
}

export const HasInstallation: Story = {
  render: () => <AddGithubConnectorButton orgSlug={orgSlug} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          bootstrapHosted,
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/github/installation",
              ),
            () => HttpResponse.json({ id: "gh_inst_1" }),
          ),
        ],
      },
    },
  },
}

export const Loading: Story = {
  render: () => <AddGithubConnectorButton orgSlug={orgSlug} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          bootstrapHosted,
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/github/installation",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json(null)
            },
          ),
        ],
      },
    },
  },
}
