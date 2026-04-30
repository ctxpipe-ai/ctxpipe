import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { githubConnectorBootstrapHandler } from "../mocks/github-bootstrap-msw"
import { AddConfluenceConnectorButton } from "./AddConfluenceConnectorButton"
import { AddConnectorCatalogDialog } from "./AddConnectorCatalogDialog"
import { AddGithubConnectorButton } from "./AddGithubConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/AddConnectionModal",
  component: AddConnectorCatalogDialog,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof AddConnectorCatalogDialog>

export default meta

type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: () => (
    <AddConnectorCatalogDialog isOpen onOpenChange={() => {}}>
      <li>
        <div className="rounded-none border border-zinc-800 bg-zinc-900/40 p-4 text-left text-sm text-zinc-400">
          Placeholder connector row (use WithActions for real buttons)
        </div>
      </li>
    </AddConnectorCatalogDialog>
  ),
}

export const WithActions: Story = {
  render: () => (
    <AddConnectorCatalogDialog isOpen onOpenChange={() => {}}>
      <li>
        <AddGithubConnectorButton orgSlug={orgSlug} />
      </li>
      <li>
        <AddConfluenceConnectorButton
          orgSlug={orgSlug}
          onInstallIntentRegistered={() => {}}
        />
      </li>
    </AddConnectorCatalogDialog>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          githubConnectorBootstrapHandler({
            orgSlug,
            hostedDefaultAppInstallUrl:
              "https://github.com/apps/ctxpipe-agent/installations/select_target",
          }),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/github/installation",
              ),
            () => HttpResponse.json(null),
          ),
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/installation",
              ),
            () => HttpResponse.json({ id: "new_forge_conn" }),
          ),
        ],
      },
    },
  },
}
