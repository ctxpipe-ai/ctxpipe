import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { AddGithubConnectorButton } from "./AddGithubConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/AddGithubConnectorButton",
  component: AddGithubConnectorButton,
  decorators: entryPageInnerDecorators,
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
  render: () => (
    <div className="w-96">
      <AddGithubConnectorButton orgSlug={orgSlug} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
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
  render: () => (
    <div className="w-96">
      <AddGithubConnectorButton orgSlug={orgSlug} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
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
  render: () => (
    <div className="w-96">
      <AddGithubConnectorButton orgSlug={orgSlug} />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
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
